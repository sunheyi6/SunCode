import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { MAX_TURNS } from '@shared/constants';
import type {
  AppSettings,
  ContentBlock,
  Message,
  RunEvent,
  StopHookRegistry,
  StreamEvent,
  ToolCallContent,
  ToolDefinition,
  ToolResult,
} from '@shared/types';

import type { Tool } from '../tools/types';
import { DiagLogger } from '../utils/diag-logger';
import { buildSystemPrompt } from './system-prompt';
import { computeNeedsFollowUp } from './turn-decision';
import { handleStream } from './stream-handler';
import { executeTools } from './tool-executor';
import { StreamingToolExecutor } from './streaming-executor';

/** Context passed to prepareNextTurn so implementors can trim or adjust. */
export interface PrepareNextTurnContext {
  assistantText: string;
  thinkingText: string;
  toolResults: ToolResult[];
  contextMessages: Message[];
  turnCount: number;
  maxTurns: number;
  /** Model's maximum context window size (tokens). Available for budget decisions. */
  modelContextWindow?: number;
}

export interface AgentLoopInput {
  model: unknown; // pi-ai Model type
  messages: Message[];
  tools: Tool[];
  settings: AppSettings;
  workingDir: string;
  skillsContent: string;
  /** Content from .agents.md / AGENTS.md (Codex-style workspace instructions). */
  agentsMdContent?: string;
  /** Plan mode instructions to inject into the system prompt (only when plan mode is active). */
  planModeInstructions?: string;
  /** Auto-generated memories from prior sessions. */
  memoryContent?: string;
  abortSignal: AbortSignal;
  /** Unique identifier for this run (used for event logging). */
  runId: string;
  /** Stable session identifier for prompt cache affinity. */
  sessionId: string;
  onStream: (event: StreamEvent) => void;
  onToolStart: (toolCall: ToolCallContent) => void;
  onToolEnd: (result: ToolResult) => void;
  onToolProgress: (toolCallId: string, output: string) => void;
  /** Callback for recording run lifecycle events (turns, tools, etc.). */
  onRunEvent: (event: RunEvent) => void;
  initialTurnCount: number;
  /** Optional hook called after each intermediate turn. Can trim context or return
   *  new settings for the next turn (e.g. switch model, adjust thinking). */
  prepareNextTurn?: (ctx: PrepareNextTurnContext) => PrepareNextTurnResult | undefined;
  /** Stop hook registry for post-turn checks (verification, safety, etc.). */
  stopHooks?: StopHookRegistry;
  /** Whether there is pending user input that was queued while the agent was running. */
  hasPendingInput?: boolean;
  /** Callback to request user confirmation before executing a destructive tool.
   *  Only called when permissionMode is 'confirm_changes'. */
  requestConfirmation?: (toolCall: ToolCallContent) => Promise<boolean>;
  /** Optional callback fired on each turn_start to keep external state in sync.
   *  tokenUsage is the accumulated token count for the current run so far. */
  onTurnStart?: (
    turnCount: number,
    maxTurns: number,
    tokenUsage: { input: number; output: number; total: number },
  ) => void;
}

export interface PrepareNextTurnResult {
  /** Replacement messages for the next turn (e.g. after compaction). */
  contextMessages?: Message[];
}

export interface AgentLoopResult {
  finalMessage: Message;
  turnCount: number;
  tokenUsage: { input: number; output: number; total: number };
  /** Structured decision about why the loop terminated. */
  decision: { decision: string; reason: string; taxonomy?: string };
}

/**
 * Core agent loop: prompt → LLM stream → tool execution → repeat.
 *
 * Termination is driven by the model's natural stop signals:
 * - Model called tools → execute them, then continue
 * - Model called task_complete → explicit stop signal
 * - Model produced only text → natural stop, no follow-up needed
 * - Max turns / abort → stop
 *
 * No text markers (## 最终结果, [STATUS:N]) are required or checked.
 * Follows pi-agent-core's approach: trust the model's stopReason.
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const {
    model,
    messages: initialMessages,
    tools,
    settings,
    workingDir,
    skillsContent,
    agentsMdContent,
    memoryContent,
    planModeInstructions,
    abortSignal,
    runId,
    sessionId,
    onStream,
    onToolStart,
    onToolEnd,
    onToolProgress,
    onRunEvent,
    initialTurnCount,
    prepareNextTurn,
    stopHooks,
    hasPendingInput: inputHasPending,
    requestConfirmation,
  } = input;

  if (!model) {
    throw new Error('未配置模型。请在设置中选择一个模型并配置 API Key。');
  }

  const streamSimpleFn: (
    model: unknown,
    context: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => AsyncIterable<AssistantMessageEvent> = await (async () => {
    try {
      const pi = await import('@earendil-works/pi-ai');
      const fn = pi.streamSimple as unknown as typeof streamSimpleFn;
      if (!fn) {
        throw new Error('streamSimple not found in pi-ai exports');
      }
      return fn;
    } catch (importErr) {
      console.error('[AgentLoop] Failed to import pi-ai:', importErr);
      throw new Error(
        `无法加载 AI 库：${(importErr as Error).message}。请确保已安装 @earendil-works/pi-ai。`,
      );
    }
  })();

  const contextMessages: Message[] = [...initialMessages];
  let turnCount = initialTurnCount;
  const tokenUsage = { input: 0, output: 0, total: 0 };

  // Diagnostic logger: persists to .suncode/diagnostics/<runId>.log
  const diag = new DiagLogger(workingDir, runId);
  diag.enter(
    'RUN',
    `model=${settings.activeProvider}/${settings.activeModel} tools=${tools.length} maxTurns=${settings.maxTurns || MAX_TURNS}`,
  );

  // Build tool definitions for the LLM
  const toolDefs = tools.map((t) => t.getDefinition());

  // Build system prompt
  const systemPrompt = buildSystemPrompt({
    workingDir,
    tools: toolDefs,
    skillsContent,
    permissionMode: settings.permissionMode,
    agentsMdContent,
    memoryContent,
    planModeInstructions,
  });

  // Prepend system message
  contextMessages.unshift({ role: 'system', content: systemPrompt });

  // No prefix injection — user message goes to model as-is.
  // Follows pi-agent-core's approach: keep the prompt minimal.

  // Emit system prompt for call trace panel
  onStream({ type: 'system_prompt', systemPrompt });

  console.log(
    `[AgentLoop] Starting with model=${settings.activeProvider}/${settings.activeModel}, tools=${tools.length}`,
  );

  // Main loop
  while (turnCount < (settings.maxTurns || MAX_TURNS)) {
    if (abortSignal.aborted) {
      const err = new Error('已中止') as Error & { name: string };
      err.name = 'AbortError';
      throw err;
    }

    turnCount++;
    console.log(`[AgentLoop] Turn ${turnCount}/${settings.maxTurns}`);
    diag.enter('TURN', `${turnCount}/${settings.maxTurns || MAX_TURNS}`, {
      msgs: contextMessages.length,
    });
    onStream({ type: 'turn_start', turnCount, maxTurns: settings.maxTurns || MAX_TURNS });
    onRunEvent({ type: 'turn_started', runId, turnNumber: turnCount, timestamp: '' });
    input.onTurnStart?.(turnCount, settings.maxTurns || MAX_TURNS, { ...tokenUsage });

    try {

      // Build context for pi-ai
      const piContext = {
        systemPrompt,
        messages: contextMessages.filter((m) => m.role !== 'system').map(convertMessage),
        tools: toolDefs.map(convertToolDef),
      };

      console.log(
        `[AgentLoop] Turn ${turnCount} calling LLM: ${piContext.messages.length} msgs` +
          ` (${systemPrompt.length} sys, ~${Math.round(systemPrompt.length / 3.5)} tokens)` +
          ` | tools=${toolDefs.length} | session=${sessionId.slice(0, 8)}`,
      );
      diag.enter('LLM', `call`, {
        msgs: piContext.messages.length,
        sysTokens: Math.round(systemPrompt.length / 3.5),
        tools: toolDefs.length,
      });

      // Log the last 2 non-system messages
      const lastMsgsForLog = contextMessages.filter((m) => m.role !== 'system').slice(-3);
      for (let mi = 0; mi < lastMsgsForLog.length; mi++) {
        const m = lastMsgsForLog[mi];
        const contentStr = getMessageTextContent(m);
        diag.log('LLM_REQUEST_INPUT', `[msg-${mi}] role=${m.role} len=${contentStr.length}`, {
          content: contentStr,
        });
      }


      // Capture request message summaries for turn_detail event
      const requestMsgSummaries = lastMsgsForLog.map((m) => {
        const contentStr = getMessageTextContent(m);
        return {
          role: m.role,
          length: contentStr.length,
          preview: contentStr.slice(0, 200),
        };
      });

      // Call the LLM with real token-by-token streaming + prompt caching
      const requestStartTime = Date.now();
      const requestAttempt = 1;

      onRunEvent({
        type: 'model_request_started',
        runId,
        turnNumber: turnCount,
        attempt: requestAttempt,
        provider: settings.activeProvider,
        model: settings.activeModel,
        timestamp: '',
      });

      // ===== Streaming Tool Pre-Executor =====
      // Create executor that can start read-only tools during LLM streaming
      const streamingExecutor = new StreamingToolExecutor(
        tools,
        workingDir,
        settings.permissionMode === 'confirm_changes',
        {
          onToolStart,
          onToolEnd,
          onToolProgress: (toolCallId, output) => onToolProgress(toolCallId, output),
        },
      );

      const stream = streamSimpleFn(model, piContext, {
        reasoning: settings.thinkingLevel,
        signal: abortSignal,
        cacheRetention: 'long',
        sessionId,
      });

      const streamResult = await handleStream({
        stream,
        onStream,
        onRunEvent: (event) => onRunEvent(event),
        diag,
        settings: settings,
        systemPrompt,
        runId,
        turnCount,
        requestAttempt,
        requestStartTime,
        requestMsgSummaries,
        // Pre-execute read-only tools as soon as their blocks are complete
        onToolCallComplete: (tc) => streamingExecutor.onToolCallComplete(tc),
      });

      const { assistantText, thinkingText, toolCalls } = streamResult;
      tokenUsage.input += streamResult.tokenUsage.input;
      tokenUsage.output += streamResult.tokenUsage.output;
      tokenUsage.total += streamResult.tokenUsage.total;

      // ===== Turn Decision =====
      // Compute whether we need another turn based on tool calls and signals.
      const { decision: turnDecision } = computeNeedsFollowUp({
        toolCalls: toolCalls,
        hasPendingInput: Boolean(inputHasPending),
        isMaxTurnsReached: turnCount >= (settings.maxTurns || MAX_TURNS),
        isAborted: false,
        assistantText,
        hasTaskComplete: false,
      });
      console.log(
        `[AgentLoop] Turn ${turnCount} decision: ${turnDecision.decision}` +
          ` (reason=${turnDecision.reason}, tools=${toolCalls.length},` +
          ` textLen=${assistantText.length})`,
      );
      diag.milestone('DECISION', `${turnDecision.decision}`, {
        reason: turnDecision.reason,
        tools: toolCalls.length,
        textLen: assistantText.length,
        assistantTextPreview: assistantText.slice(0, 500),
      });

      // Stop decision — model finished its turn naturally
      if (turnDecision.decision === 'stop') {
        console.log(
          `[AgentLoop] Stop decision: reason=${turnDecision.reason}, taxonomy=${turnDecision.taxonomy || 'none'}`,
        );

        // Push current assistant message before finalizing
        const interimBlocks: ContentBlock[] = [];
        if (thinkingText) interimBlocks.push({ type: 'thinking', text: thinkingText });
        if (assistantText) interimBlocks.push({ type: 'text', text: assistantText });
        else interimBlocks.push({ type: 'text', text: '处理中...' });
        contextMessages.push({ role: 'assistant', content: interimBlocks, toolCalls });

        // Run stop hooks before finalizing (safety checks)
        if (stopHooks) {
          const hookResult = await stopHooks.runAll({
            assistantText,
            thinkingText,
            toolCalls,
            toolResults: [],
            turnCount,
            maxTurns: settings.maxTurns || MAX_TURNS,
            tokenUsage,
          });

          if (hookResult.shouldStop) {
            const mergedText = mergeThinkingIntoAnswer(assistantText, thinkingText);
            onStream({
              type: 'message_end',
              data: {
                text: mergedText,
                thinking: thinkingText,
                toolCalls: [...toolCalls],
                isFinished: true,
              },
            });
            onStream({ type: 'turn_end', turnCount, hasToolCalls: false });
            onRunEvent({
              type: 'turn_completed',
              runId,
              turnNumber: turnCount,
              hasToolCalls: false,
              timestamp: '',
              taxonomy: 'blocked',
            });

            const contentBlocks: Array<
              { type: 'thinking'; text: string } | { type: 'text'; text: string }
            > = [];
            if (thinkingText) contentBlocks.push({ type: 'thinking', text: thinkingText });
            contentBlocks.push({ type: 'text', text: mergedText });

            return {
              finalMessage: { role: 'assistant', content: contentBlocks },
              turnCount,
              tokenUsage,
              decision: { decision: 'stop', reason: 'blocked', taxonomy: 'blocked' },
            };
          }

          if (hookResult.shouldBlock && hookResult.continuationPrompt) {
            contextMessages.push({
              role: 'assistant',
              content: [{ type: 'text', text: assistantText || '处理中...' }],
            });
            contextMessages.push({
              role: 'user',
              content: hookResult.continuationPrompt,
            });
            onStream({ type: 'turn_end', turnCount, hasToolCalls: false });
            onRunEvent({
              type: 'turn_completed',
              runId,
              turnNumber: turnCount,
              hasToolCalls: false,
              timestamp: '',
            });
            continue;
          }
        }

        // Normal stop — model finished naturally
        const displayText = mergeThinkingIntoAnswer(assistantText, thinkingText);

        onStream({
          type: 'message_end',
          data: {
            text: displayText,
            thinking: thinkingText,
            toolCalls: [...toolCalls],
            isFinished: true,
          },
        });
        onStream({ type: 'turn_end', turnCount, hasToolCalls: toolCalls.length > 0 });
        onRunEvent({
          type: 'turn_completed',
          runId,
          turnNumber: turnCount,
          hasToolCalls: toolCalls.length > 0,
          timestamp: '',
          taxonomy: turnDecision.taxonomy,
        });

        const contentBlocks: Array<
          { type: 'thinking'; text: string } | { type: 'text'; text: string }
        > = [];
        if (thinkingText) contentBlocks.push({ type: 'thinking', text: thinkingText });
        contentBlocks.push({ type: 'text', text: displayText });

        console.log(
          `[AgentLoop] === LOOP EXIT: stop (reason=${turnDecision.reason}) ===` +
            `  turns=${turnCount} tokens={in:${tokenUsage.input} out:${tokenUsage.output} total:${tokenUsage.total}}`,
        );
        diag.exit('LOOP', `stop`, {
          reason: turnDecision.reason,
          turns: turnCount,
          tokensIn: tokenUsage.input,
          tokensOut: tokenUsage.output,
          tokensTotal: tokenUsage.total,
        });

        return {
          finalMessage: { role: 'assistant', content: contentBlocks },
          turnCount,
          tokenUsage,
          decision: turnDecision,
        };
      }

      if (abortSignal.aborted) {
        const err2 = new Error('已中止') as Error & { name: string };
        err2.name = 'AbortError';
        throw err2;
      }

      // ===== Execute Tools =====
      // Collect pre-executed results (read-only tools that ran during streaming)
      // and execute remaining deferred (write) tools.
      const preExecResults = await streamingExecutor.collectAllResults();
      const preExecIds = new Set(preExecResults.map((r) => r.toolCallId));

      // Determine which tool calls still need execution
      const remainingCalls = toolCalls.filter((tc) => !preExecIds.has(tc.id));

      let toolResults: ToolResult[];
      if (remainingCalls.length > 0) {
        const deferredResult = await executeTools({
          toolCalls: remainingCalls,
          tools,
          settings: settings,
          workingDir,
          runId,
          onToolStart,
          onToolEnd,
          onToolProgress,
          onRunEvent: (event) => onRunEvent(event),
          diag,
          requestConfirmation,
        });
        toolResults = [...preExecResults, ...deferredResult.results];
      } else {
        toolResults = preExecResults;
      }

      // Ensure results are in the same order as toolCalls
      const resultMap = new Map(toolResults.map((r) => [r.toolCallId, r]));
      toolResults = toolCalls
        .map((tc) => resultMap.get(tc.id))
        .filter((r): r is ToolResult => r !== undefined);

      // Add assistant + tool results to context
      const assistantBlocks: ContentBlock[] = [];
      if (thinkingText) assistantBlocks.push({ type: 'thinking', text: thinkingText });
      if (assistantText) assistantBlocks.push({ type: 'text', text: assistantText });
      if (assistantBlocks.length === 0) {
        assistantBlocks.push({ type: 'text', text: assistantText || '处理中...' });
      }
      const assistantMsg2: Message = {
        role: 'assistant',
        content: assistantBlocks,
        toolCalls,
      };
      contextMessages.push(assistantMsg2);

      for (const tr of toolResults) {
        contextMessages.push({
          role: 'tool',
          content: tr.success ? tr.output : `错误: ${tr.error}`,
          toolCallId: tr.toolCallId,
        });
      }

      // Emit turn_end for intermediate (tool-use) turns
      const turnDurationMs = Date.now() - requestStartTime;
      console.log(
        `[AgentLoop] Turn ${turnCount} end: ${turnDurationMs}ms` +
          ` | tokens: +${tokenUsage.input + tokenUsage.output} (acc ${tokenUsage.total})` +
          ` | msgs: ${contextMessages.length}`,
      );
      diag.exit('TURN', `${turnCount}`, {
        durationMs: turnDurationMs,
        tokensTotal: tokenUsage.total,
        msgs: contextMessages.length,
      });
      onStream({ type: 'turn_end', turnCount, hasToolCalls: true });
      onRunEvent({
        type: 'turn_completed',
        runId,
        turnNumber: turnCount,
        hasToolCalls: true,
        timestamp: '',
      });

      // Allow hook to trim context or adjust state before the next turn
      if (prepareNextTurn) {
        const beforeMsgs = contextMessages.length;
        const modelContextWindow = extractContextWindow(model);
        const result2 = prepareNextTurn({
          assistantText,
          thinkingText,
          toolResults,
          contextMessages,
          turnCount,
          maxTurns: settings.maxTurns || MAX_TURNS,
          modelContextWindow,
        });
        if (result2?.contextMessages) {
          contextMessages.length = 0;
          contextMessages.push(...result2.contextMessages);
          console.log(`[AgentLoop] Compaction: ${beforeMsgs}→${contextMessages.length} msgs`);
        }
      }

      // Continue loop
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        console.log('[AgentLoop] Loop aborted');
        diag.exit('LOOP', 'aborted');
        throw new DOMException('Aborted', 'AbortError');
      }
      console.error('[AgentLoop] Unhandled error in loop:', error);
      diag.exit('LOOP', 'error', { error: (error as Error).message.slice(0, 200) });
      throw error;
    }
  }

  // Max turns reached
  console.log(
    `[AgentLoop] === LOOP EXIT: max turns (${settings.maxTurns || MAX_TURNS}) ===` +
      `\n  turns=${turnCount} tokens={in:${tokenUsage.input} out:${tokenUsage.output} total:${tokenUsage.total}}` +
      `\n  finalMsgs=${contextMessages.length}`,
  );
  diag.exit('LOOP', 'max_turns', {
    maxTurns: settings.maxTurns || MAX_TURNS,
    turns: turnCount,
    tokensTotal: tokenUsage.total,
    msgs: contextMessages.length,
  });

  return {
    finalMessage: {
      role: 'assistant',
      content: `已达到最大轮次限制（${settings.maxTurns}轮）。请尝试更具体的提问，或调整设置中的最大轮次。`,
    },
    turnCount,
    tokenUsage,
    decision: { decision: 'stop', reason: 'max_turns', taxonomy: 'max_turns_exhausted' },
  };
}

// ===== Helpers =====

function convertMessage(msg: Message): Record<string, unknown> {
  // Tool results must be sent with role "toolResult" (pi-ai converts this
  // to provider-specific formats: role "tool" for OpenAI/DeepSeek,
  // role "user" with tool_result content blocks for Anthropic).
  // The old approach converted to role "user" which lost the tool-result
  // semantics and confused the model.
  if (msg.role === 'tool') {
    const content =
      typeof msg.content === 'string'
        ? [{ type: 'text' as const, text: msg.content }]
        : msg.content
            .filter((b) => b.type === 'text' || b.type === 'thinking')
            .map((b) => {
              if (b.type === 'thinking')
                return { type: 'text' as const, text: (b as { text: string }).text };
              return { type: 'text' as const, text: b.text };
            });
    return {
      role: 'toolResult' as const,
      content,
      toolCallId: msg.toolCallId || '',
    };
  }

  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content };
  }

  const content = msg.content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'thinking') return { type: 'thinking', text: block.text };
    if (block.type === 'tool_call')
      return {
        type: 'toolCall' as const,
        id: block.id,
        name: block.name,
        arguments: safeParseJson(block.arguments),
      };
    return block;
  });

  // Include tool_calls from msg.toolCalls (stored separately from content blocks).
  // pi-ai expects ToolCall blocks ({ type: "toolCall", id, name, arguments })
  // in the content array for ALL providers.
  const toolCalls =
    msg.toolCalls && msg.toolCalls.length > 0
      ? msg.toolCalls.map((tc) => ({
          type: 'toolCall' as const,
          id: tc.id,
          name: tc.name,
          arguments: safeParseJson(tc.arguments),
        }))
      : [];

  return {
    role: msg.role as string,
    content: [...content, ...toolCalls],
    ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
  };
}

function convertToolDef(tool: ToolDefinition): Record<string, unknown> {
  // pi-ai expects { name, description, parameters } where parameters is
  // the full JSON Schema object (with type, properties, required).
  // The provider layer (e.g. Anthropic) reads parameters.properties and
  // parameters.required to build provider-specific formats like input_schema.
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

/**
 * Return the assistant text as-is. Thinking content belongs in the CallTracePanel,
 * not merged into the chat's visible answer.
 */
function mergeThinkingIntoAnswer(assistantText: string, _thinkingText: string): string {
  return assistantText || '已完成。';
}

function extractContextWindow(model: unknown): number {
  const m = model as Record<string, unknown> | null | undefined;
  if (!m) return 128_000;
  for (const key of ['contextWindow', 'context_window', 'maxInputTokens', 'max_input_tokens']) {
    const val = m[key];
    if (typeof val === 'number' && val > 0) return val;
  }
  return 128_000;
}

function getMessageTextContent(msg: Message): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  return msg.content
    .filter((b) => b.type === 'text' || b.type === 'thinking')
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n');
}
