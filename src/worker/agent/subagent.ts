/**
 * Sub-agent dispatcher — manages sub-agent lifecycle within the agent worker thread.
 *
 * Design decisions (from docs/subagent-architecture-comparison.md):
 * - Logical sandbox (not OS process) → ~30ms startup vs 300ms for fork
 * - Context isolation via data-level messages[] construction
 * - Tool whitelist enforcement
 * - Depth guard (max 3) + cycle detection
 * - Named persistent sessions (in-memory Map, keyed by parentSession + agent + handle)
 */
import { cpus } from 'node:os';
import { CHARS_PER_TOKEN } from '@shared/constants';
import type {
  AppSettings,
  Message,
  RunEvent,
  StreamEvent,
  SubagentCall,
  SubagentDefinition,
  SubagentExecution,
  SubagentProgressDelta,
  SubagentResult,
  ToolCallContent,
  ToolResult,
  UiLanguage,
} from '@shared/types';
import { createModelRegistry } from '../models/registry';
import { createToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import { getAgentDataSubdir } from './agent-data-dir';
import { type AgentLoopResult, runAgentLoop } from './agent-loop';
import { estimateMessagesTokens } from './context-budget';
import {
  resolveSubagentMaxTurns,
  resolveSubagentThinkingLevel,
  SUBAGENT_BUDGET,
} from './subagent-budget';
import { archiveToolResultBody } from './tool-result-archive';

// ===== Types =====

export interface SubagentCallbacks {
  onStream: (event: StreamEvent) => void;
  onToolStart: (toolCall: ToolCallContent) => void;
  onToolEnd: (result: ToolResult) => void;
  onRunEvent: (event: RunEvent) => void;
  onSubagentStart: (execution: SubagentExecution) => void;
  onSubagentEnd: (id: string, result: SubagentResult) => void;
  onSubagentProgress: (executionId: string, agent: string, delta: SubagentProgressDelta) => void;
}

export interface SubagentDispatchOptions {
  settings: AppSettings;
  workingDir: string;
  parentMessages: Message[];
  parentSessionId: string;
  abortSignal: AbortSignal;
  depth: number;
  ancestorStack: string[];
  callbacks: SubagentCallbacks;
  memoryContent?: string;
  relevantLessonsContent?: string;
  responseLanguage?: UiLanguage;
}

const MAX_DEPTH = 3;
const MAX_NAMED_SESSIONS = 50;

// ===== SubagentDispatcher =====

export class SubagentDispatcher {
  private definitions: Map<string, SubagentDefinition>;
  private namedSessions: Map<string, Message[]>;
  private opts: SubagentDispatchOptions;

  constructor(definitions: Map<string, SubagentDefinition>, opts: SubagentDispatchOptions) {
    this.definitions = definitions;
    this.opts = opts;
    this.namedSessions = new Map();
  }

  /** Update dispatch options (called when working dir or settings change). */
  updateOptions(partial: Partial<SubagentDispatchOptions>): void {
    Object.assign(this.opts, partial);
  }

  /** Update memory content for sub-agent runs. */
  updateMemoryContent(memoryContent: string): void {
    this.opts.memoryContent = memoryContent;
  }

  /** Update lesson context for sub-agent runs. */
  updateRelevantLessonsContent(relevantLessonsContent: string): void {
    this.opts.relevantLessonsContent = relevantLessonsContent;
  }

  /** Dispatch one or more sub-agent calls in parallel with a concurrency cap. */
  async dispatch(calls: SubagentCall[]): Promise<SubagentResult[]> {
    const cap = Math.max(1, Math.min(4, cpus().length - 1));
    const results: SubagentResult[] = [];

    // Process in batches
    for (let i = 0; i < calls.length; i += cap) {
      const batch = calls.slice(i, i + cap);
      const batchResults = await Promise.all(batch.map((call) => this.dispatchOne(call)));
      results.push(...batchResults);
    }

    return results;
  }

  /** Get all known sub-agent names. */
  listAgents(): string[] {
    return [...this.definitions.keys()];
  }

  /** Get definition for a named agent. */
  getDefinition(name: string): SubagentDefinition | undefined {
    return this.definitions.get(name);
  }

  // ===== Private =====

  private async dispatchOne(call: SubagentCall): Promise<SubagentResult> {
    console.log(
      '[SubagentDispatcher] dispatchOne: agent=',
      call.agent,
      'prompt=',
      call.prompt.slice(0, 80),
    );
    const def = this.definitions.get(call.agent);
    if (!def) {
      console.log('[SubagentDispatcher] ERROR: unknown agent:', call.agent, 'available:', [
        ...this.definitions.keys(),
      ]);
      return {
        agent: call.agent,
        success: false,
        output: '',
        tokenUsage: { input: 0, output: 0, total: 0 },
        toolCalls: 0,
        error: `未知的 Agent: "${call.agent}"。可用的 Agent: ${[...this.definitions.keys()].join(', ')}`,
      };
    }

    // Depth guard
    if (this.opts.depth >= MAX_DEPTH) {
      return {
        agent: call.agent,
        success: false,
        output: '',
        tokenUsage: { input: 0, output: 0, total: 0 },
        toolCalls: 0,
        error: `已达最大委托深度 (${MAX_DEPTH})，无法在子 Agent 中再委托`,
      };
    }

    // Cycle guard
    if (this.opts.ancestorStack.includes(call.agent)) {
      return {
        agent: call.agent,
        success: false,
        output: '',
        tokenUsage: { input: 0, output: 0, total: 0 },
        toolCalls: 0,
        error: `检测到循环委托: ${[...this.opts.ancestorStack, call.agent].join(' → ')}`,
      };
    }

    const executionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const startTime = Date.now();

    const execution: SubagentExecution = {
      id: executionId,
      agent: call.agent,
      state: 'running',
      startTime,
      prompt: call.prompt,
    };

    this.opts.callbacks.onSubagentStart(execution);

    // Abort controller linked to parent signal
    const subAbort = new AbortController();
    const onParentAbort = (): void => subAbort.abort();
    this.opts.abortSignal.addEventListener('abort', onParentAbort, { once: true });

    let budgetExceededReason: string | undefined;
    const exceedBudget = (reason: string): void => {
      if (budgetExceededReason) return;
      budgetExceededReason = reason;
      subAbort.abort();
    };

    const timeout = setTimeout(
      () => exceedBudget(`子 Agent 已超过 ${SUBAGENT_BUDGET.maxWallTimeMs / 1000} 秒时间预算`),
      SUBAGENT_BUDGET.maxWallTimeMs,
    );

    // Tool calls completed so far; kept at dispatch level so an aborted run can
    // report its partial progress to the parent instead of failing silently.
    const subToolCalls: ToolCallContent[] = [];

    try {
      const result = await this.runSubagent(
        def,
        call,
        executionId,
        subAbort.signal,
        exceedBudget,
        subToolCalls,
      );
      clearTimeout(timeout);
      this.opts.abortSignal.removeEventListener('abort', onParentAbort);

      const text = extractText(result.finalMessage);
      // Archive the full output so only a summary enters the parent context;
      // the model can read the archived file for details.
      const archivedOutput = text
        ? archiveToolResultBody(
            getAgentDataSubdir(
              this.opts.workingDir,
              '.suncode/tool-result-archive',
              this.opts.parentSessionId,
            ),
            executionId,
            text,
          )
        : undefined;
      const extras = result as AgentLoopResult & {
        thinking?: string;
        internalCalls?: ToolCallContent[];
      };
      const turnBudgetExhausted = result.decision.reason === 'max_turns';
      const partial = turnBudgetExhausted;
      const subResult: SubagentResult = {
        agent: call.agent,
        session: call.session,
        status: partial ? 'partial' : 'completed',
        success: !partial,
        output: text,
        toolCalls: extras.internalCalls?.length ?? 0,
        tokenUsage: result.tokenUsage,
        thinking: extras.thinking,
        internalCalls: extras.internalCalls,
        partialProgress: partial ? summarizeSubagentProgress(subToolCalls) : undefined,
        error: partial
          ? `子 Agent 已超过 ${resolveSubagentMaxTurns(def.maxTurns)} 轮预算`
          : undefined,
        fullOutputPath: archivedOutput?.absolutePath,
      };

      this.opts.callbacks.onSubagentEnd(executionId, subResult);
      return subResult;
    } catch (err) {
      clearTimeout(timeout);
      this.opts.abortSignal.removeEventListener('abort', onParentAbort);

      const isAbort = (err as Error).name === 'AbortError';
      // Budget aborts (and cancellations with completed tool work) carry usable
      // partial progress; only true failures report 'failed'.
      const partial = Boolean(budgetExceededReason) || (isAbort && subToolCalls.length > 0);
      const subResult: SubagentResult = {
        agent: call.agent,
        session: call.session,
        status: partial ? 'partial' : 'failed',
        success: false,
        output: '',
        toolCalls: subToolCalls.length,
        tokenUsage: { input: 0, output: 0, total: 0 },
        partialProgress: partial ? summarizeSubagentProgress(subToolCalls) : undefined,
        error: budgetExceededReason ?? (isAbort ? '子 Agent 执行被取消' : (err as Error).message),
      };

      this.opts.callbacks.onSubagentEnd(executionId, subResult);
      return subResult;
    }
  }

  private async runSubagent(
    def: SubagentDefinition,
    call: SubagentCall,
    executionId: string,
    signal: AbortSignal,
    exceedBudget: (reason: string) => void,
    subToolCalls: ToolCallContent[],
  ) {
    // Build isolated messages. A named session is the authoritative provider
    // history; parent context is only seeded when that history does not exist.
    const messages: Message[] = [];
    const sessionKey = call.session ? this.sessionKey(call) : undefined;
    const history = sessionKey ? this.namedSessions.get(sessionKey) : undefined;

    // Parent context seeding
    if (!history?.length && call.initialContext === 'parent') {
      for (const msg of this.opts.parentMessages) {
        if (msg.role !== 'system') {
          messages.push(msg);
        }
      }
      messages.push({
        role: 'user',
        content: '---\n以上是主对话上下文。下面是委托给你的任务：',
      });
    }

    // Persistent session history
    if (history?.length) {
      for (const msg of history) {
        if (msg.role !== 'system') {
          messages.push(msg);
        }
      }
    }

    // Task prompt
    messages.push({ role: 'user', content: call.prompt });

    const initialInputTokens = estimateMessagesTokens(messages, CHARS_PER_TOKEN);
    if (initialInputTokens >= SUBAGENT_BUDGET.maxInputTokens) {
      throw new Error(
        `子 Agent 初始上下文约 ${initialInputTokens} tokens，超过 ${SUBAGENT_BUDGET.maxInputTokens} 输入 token 预算`,
      );
    }

    // Build tool whitelist
    const allowedTools = this.buildToolWhitelist(def.tools);
    console.log(
      '[SubagentDispatcher] Whitelisted tools:',
      allowedTools.map((t) => t.name),
    );

    // Get model: definition model > parent model
    const modelRegistry = createModelRegistry(this.opts.settings.customEndpoints ?? []);
    const modelProvider = call.model
      ? call.model.split('/')[0]!
      : this.opts.settings.activeProvider;
    const modelId = call.model
      ? call.model.split('/').slice(1).join('/')
      : this.opts.settings.activeModel;
    console.log('[SubagentDispatcher] Loading model:', modelProvider, '/', modelId);
    const model = await modelRegistry.getModel(modelProvider, modelId);
    if (!model) {
      throw new Error(`无法加载模型: ${modelProvider}/${modelId}`);
    }
    console.log('[SubagentDispatcher] Model loaded, starting agent loop...');

    // Track sub-agent internal state for display in SubagentCard
    let subThinking = '';

    const result = await runAgentLoop({
      model,
      messages,
      tools: allowedTools,
      settings: {
        ...this.opts.settings,
        maxTurns: resolveSubagentMaxTurns(def.maxTurns),
        thinkingLevel: resolveSubagentThinkingLevel(this.opts.settings.thinkingLevel, def.thinking),
      },
      workingDir: this.opts.workingDir,
      skillsContent: '',
      agentRolePrompt: `${def.systemPrompt}\n\n请专注完成委托给你的任务，返回简洁的结果。`,
      agentsMdContent: '',
      memoryContent: this.opts.memoryContent || '',
      relevantLessonsContent: this.opts.relevantLessonsContent || '',
      responseLanguage: this.opts.responseLanguage,
      emitRuntimeContextEvent: false,
      abortSignal: signal,
      runId: executionId,
      // Use parent session + agent name for cache affinity across subagent invocations
      sessionId: `${this.opts.parentSessionId}:${call.agent}`,
      onStream: (event: StreamEvent) => {
        if (event.type === 'message_update' && event.data) {
          // Track thinking text for subagent
          const delta = event.data.thinking;
          if (delta && delta.length > subThinking.length) {
            const newThinking = delta.slice(subThinking.length);
            subThinking = delta;
            if (newThinking) {
              this.opts.callbacks.onSubagentProgress(executionId, call.agent, {
                type: 'thinking',
                text: newThinking,
              });
            }
          }
        }
      },
      onToolStart: (toolCall: ToolCallContent) => {
        subToolCalls.push({ ...toolCall, status: 'running' });
        if (subToolCalls.length > SUBAGENT_BUDGET.maxToolCalls) {
          exceedBudget(`子 Agent 已超过 ${SUBAGENT_BUDGET.maxToolCalls} 次工具调用预算`);
        }
        this.opts.callbacks.onSubagentProgress(executionId, call.agent, {
          type: 'tool_start',
          toolCall: { ...toolCall, status: 'running' },
        });
      },
      onToolEnd: (result: ToolResult) => {
        const existing = subToolCalls.find((tc) => tc.id === result.toolCallId);
        if (existing) {
          existing.status = result.success ? 'done' : 'error';
          existing.result = result;
        }
        this.opts.callbacks.onSubagentProgress(executionId, call.agent, {
          type: 'tool_end',
          toolResult: result,
        });
      },
      onToolProgress: (_toolCallId: string, _output: string) => {
        // Sub-agent tool progress throttled — not propagated
      },
      onRunEvent: (event: RunEvent) => {
        // Forward sub-agent run events to the parent so they are persisted in the run log.
        // The sub-agent's runId (executionId) differs from the parent runId, so events
        // are written to a separate JSONL file under the same session.
        this.opts.callbacks.onRunEvent(event);
      },
      onTurnStart: (_turnCount, _maxTurns, tokens) => {
        if (tokens.input >= SUBAGENT_BUDGET.maxInputTokens) {
          exceedBudget(`子 Agent 已超过 ${SUBAGENT_BUDGET.maxInputTokens} 输入 token 预算`);
        }
      },
      initialTurnCount: 0,
    });

    // Store internal state in the result for SubagentCard rendering
    (
      result as AgentLoopResult & { thinking?: string; internalCalls?: ToolCallContent[] }
    ).thinking = subThinking;
    (
      result as AgentLoopResult & { thinking?: string; internalCalls?: ToolCallContent[] }
    ).internalCalls = subToolCalls;

    // Save to named session
    if (call.session) {
      const sessionKey = this.sessionKey(call);
      if (this.namedSessions.size >= MAX_NAMED_SESSIONS && !this.namedSessions.has(sessionKey)) {
        const first = this.namedSessions.keys().next().value;
        if (first) this.namedSessions.delete(first);
      }
      this.namedSessions.set(sessionKey, result.modelMessages);
    }

    return result;
  }

  /** Build filtered tool array from whitelist. */
  private buildToolWhitelist(names: string[]): Tool[] {
    const allTools = createToolRegistry(this.opts.workingDir).getAll();
    return names.map((n) => allTools.find((t) => t.name === n)).filter(Boolean) as Tool[];
  }

  private sessionKey(call: SubagentCall): string {
    const cwd = this.opts.workingDir;
    return `${this.opts.parentSessionId}:${cwd}:${call.agent}:${call.session || '__ephemeral__'}`;
  }
}

// ===== Helpers =====

function extractText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n');
}

/** Summarize tool calls completed before an abort, so the parent can take over. */
function summarizeSubagentProgress(subToolCalls: ToolCallContent[]): string {
  const done = subToolCalls.filter((tc) => tc.status === 'done' || tc.status === 'error');
  if (done.length === 0) return '';
  const counts = new Map<string, number>();
  const files: string[] = [];
  for (const tc of done) {
    counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
    const path = toolCallFileArg(tc.arguments);
    if (path && !files.includes(path)) files.push(path);
  }
  const countsText = [...counts.entries()].map(([name, n]) => `${name}×${n}`).join('、');
  const filesText = files.slice(0, 5).join('、');
  return `已完成 ${done.length} 次工具调用（${countsText}）${filesText ? `，涉及文件：${filesText}` : ''}`;
}

/** Best-effort extraction of the file path / pattern from a tool call's JSON arguments. */
function toolCallFileArg(argumentsJson: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    const value = parsed.file_path ?? parsed.path ?? parsed.pattern;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
