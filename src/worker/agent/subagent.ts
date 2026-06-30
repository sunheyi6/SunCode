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
  ToolDefinition,
  ToolResult,
} from '@shared/types';
import type { Tool } from '../tools/types';
import { runAgentLoop, type AgentLoopResult } from './agent-loop';
import { buildSystemPrompt } from './system-prompt';
import { createToolRegistry } from '../tools/registry';
import { createModelRegistry } from '../models/registry';

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
}

const MAX_DEPTH = 3;
const MAX_NAMED_SESSIONS = 50;
const FALLBACK_MAX_TURNS = 50; // used when neither definition nor settings specify

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

    // Timeout: 5 minutes
    const timeout = setTimeout(() => subAbort.abort(), 300_000);

    try {
      const result = await this.runSubagent(def, call, executionId, subAbort.signal);
      clearTimeout(timeout);
      this.opts.abortSignal.removeEventListener('abort', onParentAbort);

      const text = extractText(result.finalMessage);
      const extras = result as AgentLoopResult & {
        thinking?: string;
        internalCalls?: ToolCallContent[];
      };
      const subResult: SubagentResult = {
        agent: call.agent,
        session: call.session,
        success: true,
        output: text,
        toolCalls: result.turnCount,
        tokenUsage: result.tokenUsage,
        thinking: extras.thinking,
        internalCalls: extras.internalCalls,
      };

      this.opts.callbacks.onSubagentEnd(executionId, subResult);
      return subResult;
    } catch (err) {
      clearTimeout(timeout);
      this.opts.abortSignal.removeEventListener('abort', onParentAbort);

      const isAbort = (err as Error).name === 'AbortError';
      const subResult: SubagentResult = {
        agent: call.agent,
        session: call.session,
        success: false,
        output: '',
        toolCalls: 0,
        tokenUsage: { input: 0, output: 0, total: 0 },
        error: isAbort ? '子 Agent 执行被取消或超时' : (err as Error).message,
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
  ) {
    // Build isolated messages
    const messages: Message[] = [];

    // Build system prompt using the standard builder
    const toolDefs = this.buildToolDefs(def.tools);
    const baseSystem = buildSystemPrompt({
      workingDir: this.opts.workingDir,
      tools: toolDefs,
      skillsContent: '',
      permissionMode: this.opts.settings.permissionMode,
    });
    const systemContent = `${baseSystem}\n\n---\n\n## 你的角色\n\n${def.systemPrompt}\n\n请专注完成委托给你的任务，返回简洁的结果。`;

    messages.push({ role: 'system', content: systemContent });

    // Parent context seeding
    if (call.initialContext === 'parent') {
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
    if (call.session) {
      const sessionKey = this.sessionKey(call);
      const history = this.namedSessions.get(sessionKey);
      if (history && history.length > 0) {
        for (const msg of history) {
          if (msg.role !== 'system') {
            messages.push(msg);
          }
        }
      }
    }

    // Task prompt
    messages.push({ role: 'user', content: call.prompt });

    // Build tool whitelist
    const allowedTools = this.buildToolWhitelist(def.tools);
    console.log(
      '[SubagentDispatcher] Whitelisted tools:',
      allowedTools.map((t) => t.name),
    );

    // Get model: definition model > parent model
    const modelRegistry = createModelRegistry();
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
    const subToolCalls: ToolCallContent[] = [];

    const result = await runAgentLoop({
      model,
      messages,
      tools: allowedTools,
      settings: {
        ...this.opts.settings,
        maxTurns: def.maxTurns ?? (this.opts.settings.maxTurns || FALLBACK_MAX_TURNS),
      },
      workingDir: this.opts.workingDir,
      skillsContent: '',
      agentsMdContent: '',
      memoryContent: this.opts.memoryContent || '',
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
      const history = this.namedSessions.get(sessionKey) || [];
      history.push({ role: 'user', content: call.prompt });
      history.push(result.finalMessage);
      if (this.namedSessions.size >= MAX_NAMED_SESSIONS && !this.namedSessions.has(sessionKey)) {
        const first = this.namedSessions.keys().next().value;
        if (first) this.namedSessions.delete(first);
      }
      this.namedSessions.set(sessionKey, history);
    }

    return result;
  }

  /** Build tool definitions for system prompt from a whitelist of names. */
  private buildToolDefs(names: string[]): ToolDefinition[] {
    const allTools = createToolRegistry(this.opts.workingDir).getAll();
    return names
      .map((n) => allTools.find((t) => t.name === n))
      .filter(Boolean)
      .map((t) => t!.getDefinition());
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
