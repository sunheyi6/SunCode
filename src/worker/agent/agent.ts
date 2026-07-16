import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CONTEXT_BUDGET_POLICY } from '@shared/constants';
import type {
  AgentStatus,
  AppSettings,
  BackgroundProcess,
  ContextBudgetPolicy,
  GoalEvent,
  Message,
  RunEvent,
  StreamEvent,
  SubagentDefinition,
  ToolCallContent,
  ToolResult,
  UiLanguage,
} from '@shared/types';
import { createMcpManager } from '../mcp/manager';
import { createModelRegistry } from '../models/registry';

import { createToolRegistry } from '../tools/registry';
import { createSubagentTool } from '../tools/subagent';
import type { Tool } from '../tools/types';
import { getAgentDataSubdir } from './agent-data-dir';
import { runAgentLoop } from './agent-loop';
import { applyContextBudget } from './context-budget';
import { extractGoalDefinition, runGoalLoop } from './goal-loop';
import { parseInitCommand } from './init-handler';
import { buildExtractionContexts, extractAndSaveLessons, loadRelevantLessons } from './lessons';
import {
  buildSessionSnapshot,
  deleteMemory,
  flushMemoryAccessCounts,
  getAllMemories,
  isMemoryWorthSaving,
  loadMemories,
  loadMemoriesWithEntries,
  type MemoryEntry,
  type StructuredFact,
  saveMemory,
  saveSessionSnapshot,
  updateMemory,
} from './memory';

import { createSkillsLoader, preloadSkills } from './skills';
import { createDefaultStopHookRegistry } from './stop-hooks';
import { SubagentDispatcher } from './subagent';
import { applyOrdinaryTaskPolicy } from './task-policy';

export class Agent {
  private workingDir: string;
  private settings: AppSettings;
  private tools: Tool[] = [];
  private dispatcher: SubagentDispatcher | null = null;
  private messages: Message[] = [];
  private abortController: AbortController | null = null;
  private isRunning = false;
  /** Whether the user requested a soft stop (with summary) vs hard abort. */
  private stopRequested = false;
  /** Monotonic counter to detect stale finally blocks after abort + new run. */
  private runGeneration = 0;
  private turnCount = 0;
  private totalTokens = { input: 0, output: 0, total: 0 };
  /** Token usage from the currently active run — merged into totalTokens on completion. */
  private activeRunTokens = { input: 0, output: 0, total: 0 };
  private currentResponseLanguage: UiLanguage = 'zh';
  /** Stable session ID for prompt cache affinity (Anthropic). */
  private sessionId: string;
  /** Mid-run guidance prompts queued via injectGuidance(); drained at each
   *  turn boundary by the agent loop so the next model turn sees them. */
  private guidanceQueue: { text: string; uiLanguage: UiLanguage }[] = [];

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
  /** Plan approval callback — blocks the agent loop until user responds. */
  private onPlanApprovalRequest:
    | ((planContent: string, planFilePath: string) => Promise<boolean>)
    | undefined;

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
    sessionId?: string,
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
    this.sessionId = sessionId ?? randomUUID();

    // Skill discovery performs filesystem I/O. Start it in the background so
    // constructing an agent never delays the project startup path.
    preloadSkills(this.workingDir, this.settings.skills, this.settings.disabledSkills);
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

      this.tools = this.createBuiltInTools();

      // Load MCP tools
      const mcpManager = createMcpManager(this.settings.mcpServers ?? []);
      const mcpTools = await mcpManager.connectAll();
      this.tools.push(...mcpTools);

      console.log(
        `Agent initialized: ${this.tools.length} tools (incl. subagent), ${definitions.size} sub-agents`,
      );
    } catch (error) {
      console.error('Agent initialization error:', error);
    }
  }

  /** Return tools filtered by the current permission mode. */
  private getEffectiveTools(): Tool[] {
    if (this.settings.permissionMode === 'plan') {
      return this.tools.filter((t) => t.isReadonly || t.name === 'write' || t.name === 'edit');
    }
    return this.tools;
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
    if (this.dispatcher) {
      this.dispatcher.updateOptions({ settings });
    }
    this.replaceBuiltInTools();
    preloadSkills(this.workingDir, settings.skills, settings.disabledSkills);
  }

  /**
   * Change the working directory without recreating the entire agent.
   * Rebuilds built-in tools to enforce the new sandbox boundary.
   * MCP tools and message history are preserved.
   */
  async setWorkingDir(path: string): Promise<void> {
    if (this.workingDir === path) return;
    this.workingDir = path;
    preloadSkills(this.workingDir, this.settings.skills, this.settings.disabledSkills);

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

    this.replaceBuiltInTools();
  }

  private createBuiltInTools(): Tool[] {
    const registry = createToolRegistry(
      this.workingDir,
      {
        onBackgroundStart: (proc) => this.onBackgroundStart(proc),
        onBackgroundComplete: (pid, code) => this.onBackgroundComplete(pid, code),
        onBackgroundPortsVerified: (pid, ports) => this.onBackgroundPortsVerified(pid, ports),
      },
      this.settings,
      { protectedPids: [process.ppid] },
      this.sessionId,
    );

    if (this.dispatcher) {
      registry.register(createSubagentTool(this.dispatcher));
    }

    return registry.getAll();
  }

  private replaceBuiltInTools(): void {
    const newBuiltInTools = this.createBuiltInTools();
    const builtInNames = new Set(newBuiltInTools.map((t) => t.name));
    this.tools = [...newBuiltInTools, ...this.tools.filter((t) => !builtInNames.has(t.name))];
  }

  setMessages(messages: Message[]): void {
    this.messages = [...messages];
    this.turnCount = 0;
    this.totalTokens = { input: 0, output: 0, total: 0 };
  }

  async prompt(text: string, uiLanguage?: UiLanguage): Promise<void> {
    if (this.isRunning) {
      this.onError('Agent is already processing a request');
      return;
    }

    this.currentResponseLanguage = uiLanguage ?? inferLatestUiLanguage(this.messages);
    this.isRunning = true;
    this.abortController = new AbortController();
    this.turnCount = 0;
    const generation = ++this.runGeneration;

    // Add user message
    const userMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text }],
      uiLanguage: this.currentResponseLanguage,
    };
    this.messages.push(userMessage);

    // Emit status
    this.activeRunTokens = { input: 0, output: 0, total: 0 };
    this.emitStatus('thinking');

    const runId = crypto.randomUUID();
    const modelName = `${this.settings.activeProvider}/${this.settings.activeModel}`;
    this.onRunEvent({ type: 'run_started', runId, timestamp: new Date().toISOString(), modelName });
    // Record the user's original prompt in the run log
    this.onRunEvent({
      type: 'turn.prompt',
      runId,
      input: text,
      timestamp: new Date().toISOString(),
    });

    // Detect /init prefix → set up AGENTS.md initialization
    const initPrompt = parseInitCommand(text);
    if (initPrompt) {
      // Replace the user message with the init instruction
      this.messages[this.messages.length - 1] = {
        role: 'user',
        content: [{ type: 'text', text: initPrompt }],
        uiLanguage: this.currentResponseLanguage,
      };
    }

    // Detect /goal prefix → run autonomous goal loop
    const goalDef = !initPrompt
      ? extractGoalDefinition(text, {
          maxGoalTurns: this.settings.goalMaxTurns,
          maxWallTimeMs: this.settings.goalMaxWallTimeMs,
        })
      : null;

    let summarizeAfterStop = false;

    try {
      if (goalDef) {
        await this.runGoalLoop(runId, goalDef);
      } else {
        await this.runLoop(runId);
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        if (this.stopRequested) {
          this.stopRequested = false;
          summarizeAfterStop = true;
        } else {
          this.onRunEvent({ type: 'run_aborted', runId, timestamp: new Date().toISOString() });
          this.emitStatus('idle');
        }
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
      if (this.runGeneration === generation) {
        this.isRunning = false;
        this.abortController = null;
      }
      // The read path only buffers access-count increments in memory; flush
      // them once the run is done so counters persist even in read-only
      // sessions that never trigger a `saveMemory`.
      flushMemoryAccessCounts();
    }

    // After the main run, inject a summary turn if the user requested a soft stop
    if (summarizeAfterStop) {
      await this.runStopSummary();
    }
  }

  async continue(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();
    const generation = ++this.runGeneration;
    this.activeRunTokens = { input: 0, output: 0, total: 0 };
    this.emitStatus('thinking');

    const runId = crypto.randomUUID();
    const modelName = `${this.settings.activeProvider}/${this.settings.activeModel}`;
    this.onRunEvent({ type: 'run_started', runId, timestamp: new Date().toISOString(), modelName });
    // Record continuation prompt in the run log
    this.onRunEvent({
      type: 'turn.prompt',
      runId,
      input: '[continue]',
      timestamp: new Date().toISOString(),
    });

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
      if (this.runGeneration === generation) {
        this.isRunning = false;
        this.abortController = null;
      }
      // The read path only buffers access-count increments in memory; flush
      // them once the continuation is done so counters persist even in
      // read-only sessions that never trigger a `saveMemory`.
      flushMemoryAccessCounts();
    }
  }

  abort(): void {
    this.stopRequested = false;
    this.abortController?.abort();
    // isRunning is reset by the running prompt()/continue() finally block
    // when it catches the AbortError — we do NOT reset it here to avoid
    // a race where a new run starts before the stale finally cleans up.
  }

  /**
   * Inject a guidance prompt into the currently running agent loop.
   *
   * Unlike prompt() (which rejects while running) and interruptAndSend()
   * (which aborts + restarts), this NEVER aborts the run: history, executed
   * operations and tool results all stay intact. The guidance is queued and
   * drained at the next turn boundary (see AgentLoopInput.drainGuidance) so
   * the next model turn sees it as a fresh user message. If it lands during a
   * would-be final turn, the loop continues for one more turn to address it.
   *
   * Satisfies the guidance contract:
   *  - 上下文连续性：only appends to this.messages, never resets.
   *  - 即时生效：next turn follows the guidance, no restart.
   *  - 动态叠加：each call adds one user message; later = higher recency.
   *  - 不篡改历史：existing assistant output is never edited.
   */
  injectGuidance(text: string, uiLanguage?: UiLanguage): void {
    const trimmed = text?.trim();
    if (!trimmed) return;
    this.guidanceQueue.push({
      text: trimmed,
      uiLanguage: uiLanguage ?? this.currentResponseLanguage,
    });
  }

  /**
   * Drain pending guidance into user messages. Called by the agent loop at
   * each turn boundary. Each drained message is ALSO appended to this.messages
   * so it survives across runs and is available for persistence. Pure w.r.t.
   * events — the loop emits guidance_injected stream/run events alongside.
   */
  drainGuidance(): Message[] {
    if (this.guidanceQueue.length === 0) return [];
    const items = this.guidanceQueue.splice(0);
    const messages: Message[] = [];
    for (const item of items) {
      const msg: Message = {
        role: 'user',
        content: [{ type: 'text', text: item.text }],
        uiLanguage: item.uiLanguage,
      };
      this.messages.push(msg);
      messages.push(msg);
    }
    return messages;
  }

  /**
   * Request a soft stop: abort the current model call, then inject a
   * summary request so the model can wrap up before the run ends.
   */
  requestStop(): void {
    this.stopRequested = true;
    this.abortController?.abort();
  }

  /**
   * Set the plan approval request handler.
   * Called by the main process to wire up the IPC-based plan approval flow.
   */
  setPlanApprovalHandler(
    handler: (planContent: string, planFilePath: string) => Promise<boolean>,
  ): void {
    this.onPlanApprovalRequest = handler;
  }

  /**
   * After a soft stop, run a single text-only turn so the model can
   * summarize what it accomplished before the conversation ends.
   */
  private async runStopSummary(): Promise<void> {
    this.isRunning = true;
    this.abortController = new AbortController();
    // Reset per-run counters: the summary turn is a fresh run and must not
    // inherit the main run's turnCount, otherwise AgentLoop's
    // `while (turnCount < maxTurns)` exits immediately and the summary
    // becomes an empty "max turns reached" placeholder with no streaming
    // events — which the renderer then fails to persist.
    this.turnCount = 0;
    this.activeRunTokens = { input: 0, output: 0, total: 0 };
    this.emitStatus('thinking');

    // Append the summary request as a user message
    this.messages.push({
      role: 'user',
      content: [{ type: 'text', text: '用户停止了对话。请简要总结你刚才完成的操作和改动。' }],
    });

    const runId = crypto.randomUUID();
    const modelName = `${this.settings.activeProvider}/${this.settings.activeModel}`;
    this.onRunEvent({ type: 'run_started', runId, timestamp: new Date().toISOString(), modelName });
    this.onRunEvent({
      type: 'turn.prompt',
      runId,
      input: '[stop-summary]',
      timestamp: new Date().toISOString(),
    });

    try {
      await this.runLoop(runId, true);
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        this.onRunEvent({ type: 'run_aborted', runId, timestamp: new Date().toISOString() });
      }
    } finally {
      this.isRunning = false;
      this.abortController = null;
      // The read path only buffers access-count increments in memory; flush
      // them once the summary run is done so counters persist even in
      // read-only sessions that never trigger a `saveMemory`.
      flushMemoryAccessCounts();
    }
  }

  private async runLoop(runId: string, summaryMode = false): Promise<void> {
    const modelRegistry = createModelRegistry(this.settings.customEndpoints ?? []);
    const model = await modelRegistry.getModel(
      this.settings.activeProvider,
      this.settings.activeModel,
    );

    if (!model) {
      this.onError(`Model not found: ${this.settings.activeProvider}/${this.settings.activeModel}`);
      return;
    }

    const skillsLoader = createSkillsLoader(
      this.workingDir,
      this.settings.skills,
      this.settings.disabledSkills,
    );
    const skillsContent = await skillsLoader.loadAll();

    // Load .agents.md (Codex convention): project-level, then user-level
    const agentsMdContent = await loadAgentsMd(this.workingDir);

    // Load auto-generated memories from prior sessions (with semantic search).
    // The retrieval query joins recent user turns so pronoun-only follow-ups
    // ("继续改一下") still match memories from earlier in the conversation.
    const userQuery = latestUserText(this.messages);
    const memoryResult = await loadMemoriesWithEntries(
      this.workingDir,
      recentUserText(this.messages),
      this.sessionId,
    );
    const memoryContent = memoryResult.content;
    const memoryEntries = memoryResult.entries;
    const relevantLessonsContent = loadRelevantLessons(
      this.workingDir,
      userQuery,
      3,
      this.sessionId,
    );

    // Share retrieved context with sub-agents
    this.dispatcher?.updateMemoryContent(memoryContent);
    this.dispatcher?.updateRelevantLessonsContent(relevantLessonsContent);

    // Summary mode is one text-only turn. Ordinary small edits get a tighter
    // turn/thinking policy so a global xhigh setting cannot make them sprawl.
    const effectiveSettings = summaryMode
      ? { ...this.settings, maxTurns: 1 }
      : applyOrdinaryTaskPolicy(this.settings, userQuery);

    // Build context budget policy from the effective settings + model info
    const contextBudgetPolicy = buildContextBudgetPolicy(
      effectiveSettings,
      contextWindowFromModel(model),
    );

    // Build plan mode instructions if active
    const effectiveTools = summaryMode ? [] : this.getEffectiveTools();

    const result = await runAgentLoop({
      model,
      messages: this.messages,
      tools: effectiveTools,
      settings: effectiveSettings,
      workingDir: this.workingDir,
      skillsContent,
      agentsMdContent,
      memoryContent,
      memoryEntries,
      relevantLessonsContent,
      responseLanguage: this.currentResponseLanguage,
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
      // Drain mid-run guidance at each turn boundary (no abort/restart).
      drainGuidance: () => this.drainGuidance(),
      prepareNextTurn: effectiveSettings.autoCompact
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
    this.saveCurrentSessionSnapshot('completed');

    // Persist a memory entry so future sessions recall what we did
    await this.saveSessionMemory();

    // Persist task plan to .suncode/plans/ if present
    this.saveTaskPlan(result.finalMessage);

    // Extract failure lessons (fire-and-forget)
    // Tool results are JSON strings from formatToolResultForModel, check success field
    const hasFailures = this.messages.some(
      (m) =>
        m.role === 'tool' &&
        typeof m.content === 'string' &&
        (m.content.includes('"success": false') || m.content.includes('"success":false')),
    );
    if (hasFailures) {
      const extractionContexts = buildExtractionContexts(this.messages, runId);
      if (extractionContexts.length > 0) {
        extractAndSaveLessons(
          extractionContexts,
          this.workingDir,
          this.settings.activeProvider,
          this.settings.maxLessons,
          this.sessionId,
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
    const modelRegistry = createModelRegistry(this.settings.customEndpoints ?? []);
    const model = await modelRegistry.getModel(
      this.settings.activeProvider,
      this.settings.activeModel,
    );

    if (!model) {
      this.onError(`Model not found: ${this.settings.activeProvider}/${this.settings.activeModel}`);
      return;
    }

    const skillsLoader = createSkillsLoader(
      this.workingDir,
      this.settings.skills,
      this.settings.disabledSkills,
    );
    const skillsContent = await skillsLoader.loadAll();
    const agentsMdContent = await loadAgentsMd(this.workingDir);
    const memoryContent = await loadMemories(this.workingDir, goalDef.description, this.sessionId);
    const relevantLessonsContent = loadRelevantLessons(
      this.workingDir,
      goalDef.description,
      3,
      this.sessionId,
    );

    // Share retrieved context with sub-agents
    this.dispatcher?.updateMemoryContent(memoryContent);
    this.dispatcher?.updateRelevantLessonsContent(relevantLessonsContent);

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
      relevantLessonsContent,
      responseLanguage: this.currentResponseLanguage,
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
      // Drain mid-run guidance at each turn boundary (no abort/restart).
      drainGuidance: () => this.drainGuidance(),
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
    this.saveCurrentSessionSnapshot(
      goalResult.state.status === 'verification_passed' ? 'completed' : 'paused',
    );

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
        this.sessionId,
      ).catch(() => {
        // Never let lesson extraction break the agent
      });
    }

    await this.saveSessionMemory();

    // Persist task plan if present (goal loop)
    this.saveTaskPlan(goalResult.finalMessage);
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

      // Skip trivial interactions (greetings, short chats without tool use);
      // explicit durable-memory requests always get recorded.
      const totalToolCalls = Object.values(toolsUsed).reduce((sum, count) => sum + count, 0);
      if (
        !isMemoryWorthSaving(userRequest, totalToolCalls) &&
        !isExplicitDurableMemoryRequest(userRequest)
      ) {
        return;
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
        scope: 'session',
      };

      const savedEntry = await saveMemory(
        this.workingDir,
        entry,
        this.settings.activeProvider,
        this.settings.activeModel,
        this.sessionId,
      );
      await promoteExplicitDurableFacts(
        this.workingDir,
        this.sessionId,
        userRequest,
        savedEntry,
        this.settings.activeProvider,
        this.settings.activeModel,
      );
    } catch {
      // Best-effort — never let memory failures break the agent
    }
  }

  private saveCurrentSessionSnapshot(status: import('./memory').SessionSnapshot['status']): void {
    try {
      saveSessionSnapshot(
        this.workingDir,
        buildSessionSnapshot({
          sessionId: this.sessionId,
          workingDir: this.workingDir,
          status,
          messages: this.messages,
        }),
      );
    } catch {
      // Best-effort — never let sleep snapshot persistence break the agent.
    }
  }

  /**
   * Persist the task plan from the assistant's final message to .suncode/plans/.
   * Scans for 📋 执行计划：or 📋 进度更新：markers and saves the plan block.
   */
  private saveTaskPlan(finalMessage: Message): void {
    try {
      const text =
        typeof finalMessage.content === 'string'
          ? finalMessage.content
          : finalMessage.content
              .filter((b) => b.type === 'text')
              .map((b) => ('text' in b ? b.text : ''))
              .join('\n');

      if (!text.includes('📋')) return;

      // Find the LAST plan marker
      const execIdx = text.lastIndexOf('📋 执行计划：');
      const progIdx = text.lastIndexOf('📋 进度更新：');
      const markerIdx = Math.max(execIdx, progIdx);
      if (markerIdx < 0) return;

      // Extract plan block: from marker to next double-newline or end
      const afterMarker = text.slice(markerIdx);
      const blockEnd = afterMarker.indexOf('\n\n');
      const planBlock = blockEnd >= 0 ? afterMarker.slice(0, blockEnd) : afterMarker;

      // Determine plan type for the filename slug
      const isProgress = progIdx > execIdx;
      const label = isProgress ? 'progress' : 'plan';
      const now = new Date();
      const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const filename = `task-${label}-${dateStr}-${timeStr}.md`;

      const plansDir = getAgentDataSubdir(this.workingDir, '.suncode/plans', this.sessionId);
      if (!existsSync(plansDir)) {
        mkdirSync(plansDir, { recursive: true });
      }

      const filePath = join(plansDir, filename);
      writeFileSync(
        filePath,
        `# Task ${isProgress ? 'Progress' : 'Plan'}\n\n${planBlock}\n`,
        'utf-8',
      );
      console.log(`[Agent] Task plan saved: ${filePath}`);
    } catch {
      // Best-effort — never let plan saving break the agent
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

export async function promoteExplicitDurableFacts(
  workingDir: string,
  sessionId: string,
  userRequest: string,
  sessionEntry: MemoryEntry,
  provider: string,
  modelId: string,
): Promise<void> {
  if (!isExplicitDurableMemoryRequest(userRequest)) return;

  const durableFacts = (sessionEntry.facts ?? []).filter(
    (fact) =>
      fact.confidence >= 0.8 &&
      (fact.type === 'preference' || fact.type === 'fact' || fact.type === 'decision'),
  );
  if (durableFacts.length === 0) return;

  const grouped = new Map<StructuredFact['type'], StructuredFact[]>();
  for (const fact of durableFacts) {
    const facts = grouped.get(fact.type) ?? [];
    facts.push(fact);
    grouped.set(fact.type, facts);
  }

  for (const [factType, facts] of grouped) {
    const scope = factType === 'preference' ? 'global' : 'project';
    const existing = getAllMemories(workingDir, sessionId, scope);
    const hasSameFacts = existing.some((entry) =>
      facts.some((fact) => (entry.facts ?? []).some((stored) => sameFact(stored, fact))),
    );
    if (hasSameFacts) continue;

    // A durable fact with the same type/subject/predicate but a different
    // object contradicts the stored one (e.g. "项目 使用 Vue" → "项目 使用
    // React"). Remove only the contradicting facts from the stored entry so
    // retrieval never surfaces both sides of a contradiction; any co-stored
    // facts that are still valid are preserved. The whole entry is deleted
    // only once every fact in it has been superseded.
    const supersededSlugs: string[] = [];
    for (const entry of existing) {
      const storedFacts = entry.facts ?? [];
      if (storedFacts.length === 0) continue;
      const kept = storedFacts.filter(
        (stored) =>
          !facts.some((fact) => sameFactStem(stored, fact) && stored.object !== fact.object),
      );
      if (kept.length === storedFacts.length) continue;
      if (kept.length === 0) {
        supersededSlugs.push(entry.slug);
      } else {
        updateMemory(workingDir, entry.date, entry.slug, { facts: kept }, sessionId);
      }
    }

    const kind =
      factType === 'preference'
        ? 'preference'
        : factType === 'decision'
          ? 'decision'
          : 'project_fact';
    const stableSlug = `durable-${kind}-${facts
      .map((fact) => `${fact.subject}-${fact.predicate}-${fact.object}`)
      .join('-')
      .replace(/[^a-zA-Z0-9一-鿿]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100)}`;

    await saveMemory(
      workingDir,
      {
        date: new Date().toISOString().slice(0, 10),
        slug: stableSlug || `durable-${kind}`,
        userRequest: userRequest.slice(0, 200),
        toolsUsed: {},
        summary: sessionEntry.summary,
        scope,
        kind,
        importance: 4,
        tags: [kind, 'auto-promoted'],
        facts,
        supersedes: supersededSlugs.length > 0 ? supersededSlugs : undefined,
      },
      provider,
      modelId,
      sessionId,
    );

    for (const slug of supersededSlugs) {
      try {
        const match = existing.find((entry) => entry.slug === slug);
        if (match) deleteMemory(workingDir, match.date, match.slug, sessionId);
      } catch {
        // Best-effort cleanup of fully-superseded memories.
      }
    }
  }
}

function isExplicitDurableMemoryRequest(request: string): boolean {
  return /记住|记一下|别忘了|不要忘|以后(?:请|都)?|长期|我的偏好|我喜欢|我习惯|默认使用|remember|don't forget|always|my preference|i prefer/i.test(
    request,
  );
}

function sameFact(left: StructuredFact, right: StructuredFact): boolean {
  return (
    left.type === right.type &&
    left.subject === right.subject &&
    left.predicate === right.predicate &&
    left.object === right.object
  );
}

/** Same fact "slot" (type/subject/predicate) regardless of the object value. */
function sameFactStem(left: StructuredFact, right: StructuredFact): boolean {
  return (
    left.type === right.type && left.subject === right.subject && left.predicate === right.predicate
  );
}

function latestUserText(messages: Message[]): string {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMsg) return '';

  return typeof lastUserMsg.content === 'string'
    ? lastUserMsg.content
    : lastUserMsg.content
        .filter((b) => b.type === 'text')
        .map((b) => ('text' in b ? b.text : ''))
        .join(' ');
}

/**
 * Join the most recent user turns (newest last) into a single retrieval query,
 * so follow-up messages that only make sense in context still match memories.
 */
function recentUserText(messages: Message[], count = 3, maxLength = 600): string {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < count; i--) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((b) => b.type === 'text')
            .map((b) => ('text' in b ? b.text : ''))
            .join(' ');
    if (text.trim()) texts.unshift(text.trim().slice(0, 200));
  }
  return texts.join(' ').slice(0, maxLength);
}

function inferLatestUiLanguage(messages: Message[]): UiLanguage {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  return lastUserMsg?.uiLanguage ?? 'zh';
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
  const markdownBody = frontmatterMatch[2]?.trim();

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
      maxTurns: 8,
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
