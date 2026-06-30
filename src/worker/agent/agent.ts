import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type {
  AgentStatus,
  AppSettings,
  BackgroundProcess,
  GoalEvent,
  Message,
  RunEvent,
  StreamEvent,
  SubagentDefinition,
  SubagentExecution,
  SubagentResult,
  ToolCallContent,
  ToolResult,
} from '@shared/types';
import { loadMemories, saveMemory, type MemoryEntry } from './memory';
import { buildExtractionContexts, extractAndSaveLessons } from './lessons';
import { createMcpManager } from '../mcp/manager';
import { createModelRegistry } from '../models/registry';
import { createToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import { createSubagentTool } from '../tools/subagent';
import { runAgentLoop } from './agent-loop';
import { createSkillsLoader } from './skills';
import { SubagentDispatcher } from './subagent';
import { applyContextBudget } from './context-budget';
import type { ContextBudgetPolicy } from '@shared/types';
import { DEFAULT_CONTEXT_BUDGET_POLICY } from '@shared/constants';
import { runGoalLoop, extractGoalDefinition } from './goal-loop';
import { createDefaultStopHookRegistry } from './stop-hooks';

export class Agent {
  private workingDir: string;
  private settings: AppSettings;
  private tools: Tool[] = [];
  private dispatcher: SubagentDispatcher | null = null;
  private messages: Message[] = [];
  private abortController: AbortController | null = null;
  private isRunning = false;
  private turnCount = 0;
  private totalTokens = { input: 0, output: 0, total: 0 };
  /** Token usage from the currently active run — merged into totalTokens on completion. */
  private activeRunTokens = { input: 0, output: 0, total: 0 };
  /** Stable session ID for prompt cache affinity (Anthropic). */
  private sessionId: string;

  private onStream: (event: StreamEvent) => void;
  private onStatus: (status: AgentStatus) => void;
  private onToolStart: (toolCall: ToolCallContent) => void;
  private onToolEnd: (result: ToolResult) => void;
  private onToolProgress: (toolCallId: string, output: string) => void;
  private onDone: (message: Message) => void;
  private onError: (message: string) => void;
  private onBackgroundStart: (proc: BackgroundProcess) => void;
  private onBackgroundComplete: (pid: number, exitCode: number) => void;
  private onBackgroundPortsVerified: (pid: number, ports: number[]) => void;
  private onRunEvent: (event: RunEvent) => void;
  private onSubagentEvent: (type: string, data: unknown) => void;
  private onGoalEvent: (event: GoalEvent) => void;
  private requestConfirmation: ((toolCall: ToolCallContent) => Promise<boolean>) | undefined;

  constructor(
    workingDir: string,
    settings: AppSettings,
    onStream: (event: StreamEvent) => void,
    onStatus: (status: AgentStatus) => void,
    onToolStart: (toolCall: ToolCallContent) => void,
    onToolEnd: (result: ToolResult) => void,
    onToolProgress: (toolCallId: string, output: string) => void,
    onDone: (message: Message) => void,
    onError: (message: string) => void,
    onBackgroundStart: (proc: BackgroundProcess) => void,
    onBackgroundComplete: (pid: number, exitCode: number) => void,
    onBackgroundPortsVerified: (pid: number, ports: number[]) => void,
    onRunEvent: (event: RunEvent) => void,
    onSubagentEvent: (type: string, data: unknown) => void,
    onGoalEvent: (event: GoalEvent) => void,
    requestConfirmation?: (toolCall: ToolCallContent) => Promise<boolean>,
  ) {
    this.workingDir = workingDir;
    this.settings = settings;
    this.onStream = onStream;
    this.onStatus = onStatus;
    this.onToolStart = onToolStart;
    this.onToolEnd = onToolEnd;
    this.onToolProgress = onToolProgress;
    this.onDone = onDone;
    this.onError = onError;
    this.onBackgroundStart = onBackgroundStart;
    this.onBackgroundComplete = onBackgroundComplete;
    this.onBackgroundPortsVerified = onBackgroundPortsVerified;
    this.onRunEvent = onRunEvent;
    this.onSubagentEvent = onSubagentEvent;
    this.onGoalEvent = onGoalEvent;
    this.requestConfirmation = requestConfirmation;
    this.sessionId = randomUUID();

    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      // Load sub-agent definitions
      const definitions = await loadAgentDefinitions(this.workingDir);

      // Create dispatcher with actual callbacks so sub-agent progress streams to UI
      this.dispatcher = new SubagentDispatcher(definitions, {
        settings: this.settings,
        workingDir: this.workingDir,
        parentMessages: this.messages,
        parentSessionId: this.sessionId,
        abortSignal: new AbortController().signal,
        depth: 0,
        ancestorStack: [],
        callbacks: {
          onStream: (event) => this.onStream(event),
          onToolStart: (tc) => this.onToolStart(tc),
          onToolEnd: (result) => this.onToolEnd(result),
          onRunEvent: (event) => this.onRunEvent(event),
          onSubagentStart: (exec) => this.onSubagentEvent('subagentStart', exec),
          onSubagentEnd: (id, result) => this.onSubagentEvent('subagentEnd', { id, result }),
          onSubagentProgress: (execId, agent, delta) =>
            this.onSubagentEvent('subagentProgress', { executionId: execId, agent, delta }),
        },
      });

      // Load built-in tools
      const registry = createToolRegistry(
        this.workingDir,
        {
          onBackgroundStart: (proc) => this.onBackgroundStart(proc),
          onBackgroundComplete: (pid, code) => this.onBackgroundComplete(pid, code),
          onBackgroundPortsVerified: (pid, ports) => this.onBackgroundPortsVerified(pid, ports),
        },
        this.settings,
        { protectedPids: [process.ppid] },
      );
      // Register subagent tool separately (after dispatcher is created)
      // to avoid circular import between tools/registry.ts and agent/subagent.ts
      registry.register(createSubagentTool(this.dispatcher));
      this.tools = registry.getAll();

      // Load MCP tools
      const mcpManager = createMcpManager(this.settings.mcpServers);
      const mcpTools = await mcpManager.connectAll();
      this.tools.push(...mcpTools);

      // Load skills
      const skillsLoader = createSkillsLoader(this.workingDir, this.settings.skills);
      const skillsContent = await skillsLoader.loadAll();

      console.log(
        `Agent initialized: ${this.tools.length} tools (incl. subagent), ${definitions.size} sub-agents, ${skillsContent.length} skills chars`,
      );
    } catch (error) {
      console.error('Agent initialization error:', error);
    }
  }

  /** Return tools filtered by the current permission mode. */
  private getEffectiveTools(): Tool[] {
    if (this.settings.permissionMode === 'plan') {
      return this.tools.filter((t) => t.isReadonly);
    }
    return this.tools;
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
    if (this.dispatcher) {
      this.dispatcher.updateOptions({ settings });
    }
  }

  /**
   * Change the working directory without recreating the entire agent.
   * Rebuilds built-in tools to enforce the new sandbox boundary.
   * MCP tools and message history are preserved.
   */
  async setWorkingDir(path: string): Promise<void> {
    if (this.workingDir === path) return;
    this.workingDir = path;

    // Reload sub-agent definitions for the new working directory
    const definitions = await loadAgentDefinitions(path);
    if (this.dispatcher) {
      this.dispatcher = new SubagentDispatcher(definitions, {
        settings: this.settings,
        workingDir: path,
        parentMessages: this.messages,
        parentSessionId: this.sessionId,
        abortSignal: new AbortController().signal,
        depth: 0,
        ancestorStack: [],
        callbacks: {
          onStream: (event) => this.onStream(event),
          onToolStart: (tc) => this.onToolStart(tc),
          onToolEnd: (result) => this.onToolEnd(result),
          onRunEvent: (event) => this.onRunEvent(event),
          onSubagentStart: () => {},
          onSubagentEnd: () => {},
          onSubagentProgress: () => {},
        },
      });
    }

    // Rebuild built-in tools
    const registry = createToolRegistry(
      path,
      {
        onBackgroundStart: (proc) => this.onBackgroundStart(proc),
        onBackgroundComplete: (pid, code) => this.onBackgroundComplete(pid, code),
        onBackgroundPortsVerified: (pid, ports) => this.onBackgroundPortsVerified(pid, ports),
      },
      this.settings,
      { protectedPids: [process.ppid] },
    );
    if (this.dispatcher) {
      registry.register(createSubagentTool(this.dispatcher));
    }
    const newBuiltInTools = registry.getAll();

    // Replace built-in tools while keeping MCP tools
    const builtInNames = new Set(newBuiltInTools.map((t) => t.name));
    this.tools = [...newBuiltInTools, ...this.tools.filter((t) => !builtInNames.has(t.name))];
  }

  setMessages(messages: Message[]): void {
    this.messages = [...messages];
    this.turnCount = 0;
    this.totalTokens = { input: 0, output: 0, total: 0 };
  }

  async prompt(text: string): Promise<void> {
    if (this.isRunning) {
      this.onError('Agent is already processing a request');
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    this.turnCount = 0;

    // Add user message
    const userMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text }],
    };
    this.messages.push(userMessage);

    // Emit status
    this.activeRunTokens = { input: 0, output: 0, total: 0 };
    this.emitStatus('thinking');

    const runId = crypto.randomUUID();
    const modelName = `${this.settings.activeProvider}/${this.settings.activeModel}`;
    this.onRunEvent({ type: 'run_started', runId, timestamp: new Date().toISOString(), modelName });
    // Record the user's original prompt in the run log
    this.onRunEvent({ type: 'turn.prompt', runId, input: text, timestamp: new Date().toISOString() });

    // Detect /goal prefix → run autonomous goal loop
    const goalDef = extractGoalDefinition(text, {
      maxGoalTurns: this.settings.goalMaxTurns,
      maxWallTimeMs: this.settings.goalMaxWallTimeMs,
    });

    try {
      if (goalDef) {
        await this.runGoalLoop(runId, goalDef);
      } else {
        await this.runLoop(runId);
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        this.onRunEvent({ type: 'run_aborted', runId, timestamp: new Date().toISOString() });
        this.emitStatus('idle');
      } else {
        this.onRunEvent({
          type: 'run_failed',
          runId,
          error: (error as Error).message,
          timestamp: new Date().toISOString(),
        });
        this.onError((error as Error).message);
        this.emitStatus('error');
      }
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  async continue(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();
    this.activeRunTokens = { input: 0, output: 0, total: 0 };
    this.emitStatus('thinking');

    const runId = crypto.randomUUID();
    const modelName = `${this.settings.activeProvider}/${this.settings.activeModel}`;
    this.onRunEvent({ type: 'run_started', runId, timestamp: new Date().toISOString(), modelName });
    // Record continuation prompt in the run log
    this.onRunEvent({ type: 'turn.prompt', runId, input: '[continue]', timestamp: new Date().toISOString() });

    try {
      await this.runLoop(runId);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        this.onRunEvent({
          type: 'run_failed',
          runId,
          error: (error as Error).message,
          timestamp: new Date().toISOString(),
        });
        this.onError((error as Error).message);
        this.emitStatus('error');
      } else {
        this.onRunEvent({ type: 'run_aborted', runId, timestamp: new Date().toISOString() });
        this.emitStatus('idle');
      }
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  abort(): void {
    this.abortController?.abort();
    this.isRunning = false;
    this.emitStatus('idle');
  }

  private async runLoop(runId: string): Promise<void> {
    const modelRegistry = createModelRegistry();
    const model = await modelRegistry.getModel(
      this.settings.activeProvider,
      this.settings.activeModel,
    );

    if (!model) {
      this.onError(`Model not found: ${this.settings.activeProvider}/${this.settings.activeModel}`);
      return;
    }

    const skillsLoader = createSkillsLoader(this.workingDir, this.settings.skills);
    const skillsContent = await skillsLoader.loadAll();

    // Load .agents.md (Codex convention): project-level, then user-level
    const agentsMdContent = await loadAgentsMd(this.workingDir);

    // Load auto-generated memories from prior sessions (with semantic search)
    const lastUserMsg = this.messages.find((m) => m.role === 'user');
    const userQuery = lastUserMsg
      ? typeof lastUserMsg.content === 'string'
        ? lastUserMsg.content
        : lastUserMsg.content.filter((b) => b.type === 'text').map((b) => ('text' in b ? b.text : '')).join(' ')
      : '';
    const memoryContent = await loadMemories(this.workingDir, userQuery);

    // Share memory with sub-agents
    this.dispatcher?.updateMemoryContent(memoryContent);

    // Build context budget policy from settings + model info
    const contextBudgetPolicy = buildContextBudgetPolicy(
      this.settings,
      contextWindowFromModel(model),
    );

    const result = await runAgentLoop({
      model,
      messages: this.messages,
      tools: this.getEffectiveTools(),
      settings: this.settings,
      workingDir: this.workingDir,
      skillsContent,
      agentsMdContent,
      memoryContent,
      abortSignal: this.abortController!.signal,
      runId,
      sessionId: this.sessionId,
      onStream: (event) => {
        this.onStream(event);
      },
      onToolStart: (toolCall) => {
        this.emitStatus('executing');
        this.onToolStart(toolCall);
      },
      onTurnStart: (
        _turnCount: number,
        _maxTurns: number,
        tokens: { input: number; output: number; total: number },
      ) => {
        this.turnCount = _turnCount;
        this.activeRunTokens = tokens;
        this.emitStatus('thinking', tokens);
      },
      onToolEnd: (result) => {
        this.onToolEnd(result);
      },
      onToolProgress: (toolCallId, output) => {
        this.onToolProgress(toolCallId, output);
      },
      onRunEvent: (event) => {
        this.onRunEvent(event);
      },
      initialTurnCount: this.turnCount,
      prepareNextTurn: this.settings.autoCompact
        ? (ctx) => {
            const policy = contextBudgetPolicy;
            // Adjust max tokens based on model context window if available
            if (ctx.modelContextWindow && !policy.maxHistoryTokens) {
              policy.maxHistoryTokens = Math.floor(ctx.modelContextWindow * 0.9);
            }
            const result = applyContextBudget(ctx.contextMessages, policy);
            if (result.diagnostic.changed) {
              console.log(
                `[ContextBudget] ${result.diagnostic.beforeMessages}→${result.diagnostic.afterMessages} msgs, ` +
                  `${result.diagnostic.beforeTokens}→${result.diagnostic.afterTokens} tokens` +
                  (result.diagnostic.prunedToolResults
                    ? `, ${result.diagnostic.prunedToolResults} tool results pruned`
                    : '') +
                  (result.diagnostic.droppedTurns
                    ? `, ${result.diagnostic.droppedTurns} turns dropped`
                    : '') +
                  (result.diagnostic.compactedTurns
                    ? `, ${result.diagnostic.compactedTurns} turns compacted`
                    : ''),
              );
            }
            return { contextMessages: result.messages };
          }
        : undefined,
      stopHooks: createDefaultStopHookRegistry(),
      requestConfirmation: this.requestConfirmation,
    });

    this.turnCount = result.turnCount;
    this.totalTokens = {
      input: this.totalTokens.input + result.tokenUsage.input,
      output: this.totalTokens.output + result.tokenUsage.output,
      total: this.totalTokens.total + result.tokenUsage.total,
    };
    this.activeRunTokens = { input: 0, output: 0, total: 0 };

    // Emit run completed
    this.onRunEvent({
      type: 'run_completed',
      runId,
      turnCount: result.turnCount,
      timestamp: new Date().toISOString(),
      tokenUsage: result.tokenUsage,
      taxonomy: result.decision.decision === 'stop' ? (result.decision.taxonomy as any) : undefined,
    });

    // Add assistant message to history
    this.messages.push(result.finalMessage);

    // Emit done
    this.onDone(result.finalMessage);
    this.emitStatus('done');

    // Persist a memory entry so future sessions recall what we did
    await this.saveSessionMemory();

    // Extract failure lessons (fire-and-forget)
    const hasFailures = this.messages.some(
      (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.startsWith('错误:'),
    );
    if (hasFailures) {
      const extractionContexts = buildExtractionContexts(this.messages, runId);
      if (extractionContexts.length > 0) {
        extractAndSaveLessons(
          extractionContexts,
          this.workingDir,
          this.settings.activeProvider,
          this.settings.maxLessons,
        ).catch(() => {
          // Never let lesson extraction break the agent
        });
      }
    }
  }

  /** Run a /goal autonomous loop. */
  private async runGoalLoop(
    runId: string,
    goalDef: import('@shared/types').GoalDefinition,
  ): Promise<void> {
    const modelRegistry = createModelRegistry();
    const model = await modelRegistry.getModel(
      this.settings.activeProvider,
      this.settings.activeModel,
    );

    if (!model) {
      this.onError(`Model not found: ${this.settings.activeProvider}/${this.settings.activeModel}`);
      return;
    }

    const skillsLoader = createSkillsLoader(this.workingDir, this.settings.skills);
    const skillsContent = await skillsLoader.loadAll();
    const agentsMdContent = await loadAgentsMd(this.workingDir);
    const memoryContent = await loadMemories(this.workingDir, goalDef.description);

    // Share memory with sub-agents
    this.dispatcher?.updateMemoryContent(memoryContent);

    const contextBudgetPolicy = buildContextBudgetPolicy(
      this.settings,
      contextWindowFromModel(model),
    );

    // Build the loop config (shared across goal attempts)
    const loopConfig = {
      model,
      tools: this.getEffectiveTools(),
      settings: this.settings,
      workingDir: this.workingDir,
      skillsContent,
      agentsMdContent,
      memoryContent,
      abortSignal: this.abortController!.signal,
      sessionId: this.sessionId,
      onStream: (event: StreamEvent) => {
        this.onStream(event);
      },
      onToolStart: (toolCall: ToolCallContent) => {
        this.emitStatus('executing');
        this.onToolStart(toolCall);
      },
      onTurnStart: (
        turnCount: number,
        _maxTurns: number,
        tokens: { input: number; output: number; total: number },
      ) => {
        this.turnCount = turnCount;
        this.activeRunTokens = tokens;
        this.emitStatus('thinking', tokens);
      },
      onToolEnd: (result: ToolResult) => {
        this.onToolEnd(result);
      },
      onToolProgress: (toolCallId: string, output: string) => {
        this.onToolProgress(toolCallId, output);
      },
      onRunEvent: (event: RunEvent) => {
        this.onRunEvent(event);
      },
      initialTurnCount: 0,
      runId: '', // Will be set per-attempt
      prepareNextTurn: this.settings.autoCompact
        ? (ctx: import('./agent-loop').PrepareNextTurnContext) => {
            const policy = contextBudgetPolicy;
            if (ctx.modelContextWindow && !policy.maxHistoryTokens) {
              policy.maxHistoryTokens = Math.floor(ctx.modelContextWindow * 0.9);
            }
            const budgetResult = applyContextBudget(ctx.contextMessages, policy);
            return { contextMessages: budgetResult.messages };
          }
        : undefined,
    };

    const goalLoopConfig: import('./goal-loop').GoalLoopInput['loopConfig'] = {
      ...loopConfig,
      runId,
    };

    const { result: goalResult, messages: goalMessages } = await runGoalLoop({
      loopConfig: goalLoopConfig,
      goal: goalDef,
      messages: this.messages,
      onGoalEvent: (event) => {
        this.onGoalEvent(event);
        // Forward all goal events to run event log for debugging
        switch (event.type) {
          case 'goal_started':
            this.onRunEvent({
              type: 'goal_started',
              runId,
              goal: event.goal,
              timestamp: new Date().toISOString(),
            });
            break;
          case 'goal_turn_completed':
            this.onRunEvent({
              type: 'goal_turn_completed',
              runId,
              turnNumber: event.turnNumber,
              timestamp: new Date().toISOString(),
              verificationExitCode: event.verificationExitCode,
            });
            break;
          case 'goal_verification_passed':
          case 'goal_blocked':
          case 'goal_budget_exhausted':
          case 'goal_aborted':
            // These are terminal — full state captured in goal_completed below
            break;
          case 'goal_completed':
            this.onRunEvent({
              type: 'goal_completed',
              runId,
              status: event.state.status,
              timestamp: new Date().toISOString(),
            });
            break;
        }
      },
    });

    // Update agent state
    this.turnCount = goalResult.totalTurnCount;
    this.totalTokens = {
      input: this.totalTokens.input + goalResult.tokenUsage.input,
      output: this.totalTokens.output + goalResult.tokenUsage.output,
      total: this.totalTokens.total + goalResult.tokenUsage.total,
    };
    this.activeRunTokens = { input: 0, output: 0, total: 0 };
    this.messages = goalMessages;

    // Emit run completed
    this.onRunEvent({
      type: 'run_completed',
      runId,
      turnCount: goalResult.totalTurnCount,
      timestamp: new Date().toISOString(),
      tokenUsage: goalResult.tokenUsage,
      taxonomy: goalStatusToTaxonomy(goalResult.state.status),
    });

    // Emit done
    this.onDone(goalResult.finalMessage);
    this.emitStatus('done');

    // Extract failure lessons from goal loop (fire-and-forget)
    const goalFailed = goalResult.state.status !== 'verification_passed';
    const goalRepeatedFailure =
      goalResult.state.status === 'blocked' && goalResult.state.lastVerificationOutput
        ? {
            description: goalDef.description,
            verificationOutput: goalResult.state.lastVerificationOutput,
          }
        : undefined;

    const extractionContexts = buildExtractionContexts(this.messages, runId, goalRepeatedFailure);
    if (extractionContexts.length > 0 || goalFailed) {
      extractAndSaveLessons(
        extractionContexts,
        this.workingDir,
        this.settings.activeProvider,
        this.settings.maxLessons,
      ).catch(() => {
        // Never let lesson extraction break the agent
      });
    }

    await this.saveSessionMemory();
  }

  /** Save a summary of the current session to .suncode/memories/. */
  private async saveSessionMemory(): Promise<void> {
    try {
      const lastUserMsg = [...this.messages].reverse().find((m) => m.role === 'user');
      if (!lastUserMsg) return;

      const userRequest =
        typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : lastUserMsg.content
              .filter((b) => b.type === 'text')
              .map((b) => ('text' in b ? b.text : ''))
              .join(' ');

      const toolsUsed: Record<string, number> = {};
      for (const m of this.messages) {
        if (m.role === 'assistant' && m.toolCalls) {
          for (const tc of m.toolCalls) {
            toolsUsed[tc.name] = (toolsUsed[tc.name] || 0) + 1;
          }
        }
      }

      const slug =
        userRequest
          .slice(0, 40)
          .replace(/[^a-zA-Z0-9一-鿿]+/g, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase() || 'session';

      const entry: MemoryEntry = {
        date: new Date().toISOString().split('T')[0]!,
        slug,
        userRequest: userRequest.slice(0, 200),
        toolsUsed,
        summary: '',
      };

      await saveMemory(this.workingDir, entry, this.settings.activeProvider, this.settings.activeModel);
    } catch {
      // Best-effort — never let memory failures break the agent
    }
  }

  private emitStatus(
    state: AgentStatus['state'],
    currentTokens?: { input: number; output: number; total: number },
  ): void {
    const runTokens = currentTokens || this.activeRunTokens;
    this.onStatus({
      state,
      turnCount: this.turnCount,
      tokenUsage: {
        input: this.totalTokens.input + runTokens.input,
        output: this.totalTokens.output + runTokens.output,
        total: this.totalTokens.total + runTokens.total,
      },
      modelName: `${this.settings.activeProvider}/${this.settings.activeModel}`,
    });
  }

  getMessages(): Message[] {
    return this.messages;
  }

  getWorkingDir(): string {
    return this.workingDir;
  }
}

/**
 * Build a ContextBudgetPolicy from app settings and model context window.
 */
function buildContextBudgetPolicy(
  settings: AppSettings,
  contextWindow: number,
): ContextBudgetPolicy {
  return {
    maxHistoryTokens: Math.floor(contextWindow * (settings.compactThreshold || 0.8)),
    minRecentTurns: DEFAULT_CONTEXT_BUDGET_POLICY.minRecentTurns,
    charsPerToken: DEFAULT_CONTEXT_BUDGET_POLICY.charsPerToken,
    staleToolResultPrune: {
      ...DEFAULT_CONTEXT_BUDGET_POLICY.staleToolResultPrune,
    },
    historyCompact: {
      ...DEFAULT_CONTEXT_BUDGET_POLICY.historyCompact,
    },
  };
}

/**
 * Extract the model's context window size from the pi-ai model object.
 */
function contextWindowFromModel(model: unknown): number {
  const m = model as Record<string, unknown> | null | undefined;
  if (!m) return 128_000;
  for (const key of ['contextWindow', 'context_window', 'maxInputTokens', 'max_input_tokens']) {
    const val = m[key];
    if (typeof val === 'number' && val > 0) return val;
  }
  return 128_000;
}

/**
 * Load .agents.md files following the Codex convention.
 * Reads project-level (.agents.md in project root) and user-level (~/.agents.md).
 * Both are combined into a single instructions block for the system prompt.
 */
async function loadAgentsMd(workingDir: string): Promise<string> {
  const parts: string[] = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || '~';

  // Project-level agent instructions.
  // Different ecosystems use different names but serve the same purpose.
  // Codex → AGENTS.md, Claude Code → CLAUDE.md, Gemini → GEMINI.md.
  // .agents.md (with dot) is ~/.agents.md for user-level global context.
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const projectPath = join(workingDir, name);
    if (existsSync(projectPath)) {
      try {
        const content = await readFile(projectPath, 'utf-8');
        if (content.trim()) {
          parts.push(content.trim());
        }
        break; // Only load the first one found
      } catch {
        // Skip unreadable files
      }
    }
  }

  // User-level ~/.agents.md
  const userPath = join(homeDir, '.agents.md');
  if (existsSync(userPath)) {
    try {
      const content = await readFile(userPath, 'utf-8');
      if (content.trim()) {
        parts.push(content.trim());
      }
    } catch {
      // Skip unreadable files
    }
  }

  return parts.join('\n\n');
}

/**
 * Load sub-agent definitions from Markdown files with YAML frontmatter.
 * Scans:
 *   1. Project-level: .suncode/agents/*.md
 *   2. User-level: ~/.suncode/agents/*.md
 * Project-level definitions win on name conflicts.
 */
async function loadAgentDefinitions(workingDir: string): Promise<Map<string, SubagentDefinition>> {
  const definitions = new Map<string, SubagentDefinition>();
  const homeDir = process.env.HOME || process.env.USERPROFILE || '~';

  // Scan user-level first (project overrides)
  const userAgentsDir = join(homeDir, '.suncode', 'agents');
  await scanAgentDir(userAgentsDir, definitions);

  // Scan project-level (takes precedence)
  const projectAgentsDir = join(workingDir, '.suncode', 'agents');
  await scanAgentDir(projectAgentsDir, definitions);

  // If no definitions found, create defaults
  if (definitions.size === 0) {
    const defaults = getDefaultDefinitions();
    for (const def of defaults) {
      definitions.set(def.name, def);
    }
  }

  return definitions;
}

async function scanAgentDir(dir: string, target: Map<string, SubagentDefinition>): Promise<void> {
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      try {
        const content = await readFile(join(dir, entry), 'utf-8');
        const def = parseAgentMarkdown(content);
        if (def) {
          // Project level overrides user level
          target.set(def.name, def);
        }
      } catch {
        // Skip unreadable definitions
      }
    }
  } catch {
    // Directory may not exist — that's fine
  }
}

function parseAgentMarkdown(content: string): SubagentDefinition | null {
  // Parse YAML frontmatter between --- markers
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) return null;

  const yamlBlock = frontmatterMatch[1]!;
  const markdownBody = frontmatterMatch[2]!.trim();

  // Simple YAML parser for the subset we need
  const parsed = parseSimpleYaml(yamlBlock);
  if (!parsed.name || !parsed.description) return null;

  return {
    name: parsed.name,
    description: parsed.description,
    systemPrompt: markdownBody || parsed.description,
    tools: parsed.tools
      ? parsed.tools
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean)
      : ['read', 'bash', 'edit', 'write'],
    model: parsed.model,
    thinking: parsed.thinking,
    maxTurns: parsed.maxTurns ? Number.parseInt(parsed.maxTurns, 10) : undefined,
  };
}

function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const match = line.match(/^(\w[\w-]*):\s*(.*?)\s*$/);
    if (match) {
      result[match[1]!] = match[2]!;
    }
  }
  return result;
}

/** Built-in fallback definitions when no .md files are found. */
function getDefaultDefinitions(): SubagentDefinition[] {
  return [
    {
      name: 'explore',
      description: '代码库探索专家，用于查找文件、符号和测试。只读，不修改任何文件。',
      systemPrompt:
        '你是代码库探索专家。使用 read、grep、glob 工具查找相关文件、符号和测试。返回简洁发现，包含文件路径和行号引用。不要修改任何文件。',
      tools: ['read', 'grep', 'glob'],
      // No maxTurns limit — explore should be thorough
    },
    {
      name: 'review',
      description:
        '代码审查专家，审查变更的正确性、回归风险、测试覆盖率和可维护性。只读，不修改文件。',
      systemPrompt:
        '你是务实的代码审查员。关注实质性缺陷、边界条件、安全漏洞和可维护性问题。引用文件和行号，区分已确认问题和改进建议。报告应简洁，按严重程度排序。不要修改任何文件。',
      tools: ['read', 'grep', 'glob', 'bash'],
      maxTurns: 12,
    },
    {
      name: 'implement',
      description: '代码实现专家，编写、修改文件实现指定功能。可读写文件，执行构建和测试命令。',
      systemPrompt:
        '你是代码实现专家。根据任务描述编写或修改代码实现功能。遵循项目现有的代码风格、模式和约定。完成后运行相关测试确保改动正确。提交前自查代码质量。',
      tools: ['read', 'write', 'edit', 'bash', 'grep', 'glob'],
      maxTurns: 20,
    },
  ];
}

/** Map a GoalStatus to a TurnTaxonomy for event logging. */
function goalStatusToTaxonomy(
  status: import('@shared/types').GoalStatus,
): import('@shared/types').TurnTaxonomy {
  switch (status) {
    case 'verification_passed':
      return 'completed';
    case 'budget_exhausted':
      return 'max_turns_exhausted';
    case 'aborted':
      return 'aborted';
    case 'blocked':
      return 'blocked';
    case 'active':
      return 'completed'; // Should not happen at run_completed time
    default:
      return 'error';
  }
}
