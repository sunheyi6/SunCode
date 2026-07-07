import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { MAX_TURNS } from '@shared/constants';
import { sanitizeStructuredMessageLeak } from '@shared/finalization';
import type {
  AppSettings,
  ContentBlock,
  Message,
  RunEvent,
  StopHookRegistry,
  StreamEvent,
  TaskPlan,
  TaskStep,
  ToolCallContent,
  ToolDefinition,
  ToolResult,
  UiLanguage,
} from '@shared/types';

import type { Tool } from '../tools/types';
import { DiagLogger } from '../utils/diag-logger';

// ===== Helpers =====
import { getAgentDataSubdir } from './agent-data-dir';
import { quickMatchLesson } from './lessons';
import { buildStructuredTextMessage } from './model-structured-content';
import { handleStream } from './stream-handler';
import { StreamingToolExecutor } from './streaming-executor';
import { buildSystemPrompt } from './system-prompt';
import { executeTools } from './tool-executor';
import { formatToolResultForModel } from './tool-result-content';
import { computeNeedsFollowUp } from './turn-decision';

const TRACE_MESSAGE_CONTENT_LIMIT = 20_000;

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
  /** Auto-generated memories from prior sessions. */
  memoryContent?: string;
  /** Retrieved failure lessons relevant to this request. */
  relevantLessonsContent?: string;
  /** User-facing response language derived from the current user prompt. */
  responseLanguage?: UiLanguage;
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

function getModelApiKey(model: unknown): string | undefined {
  if (typeof model !== 'object' || model === null || !('apiKey' in model)) {
    return undefined;
  }
  const apiKey = (model as { apiKey?: unknown }).apiKey;
  return typeof apiKey === 'string' && apiKey.trim() ? apiKey : undefined;
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
    relevantLessonsContent,
    responseLanguage,
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

  let lastSystemPrompt = '';

  // Accumulate the latest 📋 plan block across turns. Each turn's assistantText
  // is single-turn only, so without accumulation the final message would only
  // carry the last turn's text — losing the plan when the last turn has no 📋
  // marker. We keep the most recent plan block (execution plan or progress
  // update) so it can be attached to the final message for the renderer.
  let accumulatedPlanBlock = '';
  let accumulatedPlanTaskType: TaskPlan['taskType'] = 'execution';

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
      const effectivePermissionMode = settings.permissionMode;
      const effectiveTools = tools;
      const toolDefs = effectiveTools.map((t) => t.getDefinition());
      const systemPrompt = buildSystemPrompt({
        workingDir,
        tools: toolDefs,
        skillsContent,
        permissionMode: effectivePermissionMode,
        agentsMdContent,
        memoryContent,
        relevantLessonsContent,
        responseLanguage,
      });
      if (systemPrompt !== lastSystemPrompt) {
        if (contextMessages[0]?.role === 'system') {
          contextMessages[0] = { role: 'system', content: systemPrompt };
        } else {
          contextMessages.unshift({ role: 'system', content: systemPrompt });
        }
        lastSystemPrompt = systemPrompt;
        onStream({ type: 'system_prompt', systemPrompt });
      }

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
        const contentStr = getModelMessageTraceContent(m);
        return {
          role: m.role,
          length: contentStr.length,
          preview: contentStr.slice(0, 200),
          content: truncateTraceContent(contentStr),
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
        effectiveTools,
        workingDir,
        effectivePermissionMode === 'confirm_changes',
        {
          runId,
          onToolStart,
          onToolEnd,
          onToolProgress: (toolCallId, output) => onToolProgress(toolCallId, output),
          onRunEvent: (event) => onRunEvent(event),
        },
      );

      const stream = streamSimpleFn(model, piContext, {
        reasoning: settings.thinkingLevel,
        signal: abortSignal,
        cacheRetention: 'long',
        sessionId,
        apiKey: getModelApiKey(model),
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

      const {
        assistantText: rawAssistantText,
        thinkingText,
        toolCalls: rawToolCalls,
      } = streamResult;
      tokenUsage.input += streamResult.tokenUsage.input;
      tokenUsage.output += streamResult.tokenUsage.output;
      tokenUsage.total += streamResult.tokenUsage.total;

      // Persist task plan to disk in real-time if 📋 marker is present
      maybeSaveTurnPlan(rawAssistantText, workingDir, sessionId);

      // Accumulate the latest plan block across turns so the final message
      // carries the plan even when the last turn has no 📋 marker.
      const planBlock = extractPlanBlock(rawAssistantText);
      if (planBlock) {
        accumulatedPlanBlock = planBlock.text;
        accumulatedPlanTaskType = planBlock.taskType;
      }

      // ===== Defensive parse: extract tool calls from suncode.message JSON in text =====
      // Some providers (DeepSeek) may output tool calls as JSON inside the text content
      // instead of using the API's native tool_calls field. This fallback catches those.
      let assistantText = rawAssistantText;
      let toolCalls = rawToolCalls;
      if (toolCalls.length === 0 && assistantText) {
        const recovered = tryParseToolCallsFromText(assistantText);
        if (recovered) {
          toolCalls = recovered.toolCalls;
          assistantText = recovered.cleanedText;
          console.log(
            `[AgentLoop] Recovered ${toolCalls.length} tool calls from suncode.message text (fallback parse)`,
          );
          diag.milestone('RECOVERY', 'tool_calls_from_text', { count: toolCalls.length });
        }
      }
      assistantText = sanitizeStructuredMessageLeak(assistantText);

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
              finalMessage: {
                role: 'assistant',
                content: contentBlocks,
                taskPlan: buildAccumulatedTaskPlan(accumulatedPlanBlock, accumulatedPlanTaskType),
              },
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
          finalMessage: {
            role: 'assistant',
            content: contentBlocks,
            taskPlan: buildAccumulatedTaskPlan(accumulatedPlanBlock, accumulatedPlanTaskType),
          },
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
          tools: effectiveTools,
          settings: { ...settings, permissionMode: effectivePermissionMode },
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
        let content = formatToolResultForModel(tr);

        // Tool result lesson enhancement: if the tool failed, check
        // for a matching lesson and append a brief hint.
        if (!tr.success && tr.error) {
          const match = quickMatchLesson(workingDir, tr.name, tr.error, sessionId);
          if (match) {
            const full = match.entry;
            content += `\n\n📌 提示：之前出现过类似失败（${full.title}）。根因：${full.rootCause}。正确做法：${full.solution}`;
          }
        }

        contextMessages.push({
          role: 'tool',
          content,
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
      content: [
        {
          type: 'text' as const,
          text: `已达到最大轮次限制（${settings.maxTurns}轮）。请尝试更具体的提问，或调整设置中的最大轮次。`,
        },
      ],
      taskPlan: buildAccumulatedTaskPlan(accumulatedPlanBlock, accumulatedPlanTaskType),
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

  if (!isStructuredTextRole(msg.role)) {
    return { role: msg.role, content: getMessageTextContent(msg) };
  }

  const structuredRole = msg.role;

  if (typeof msg.content === 'string') {
    return {
      role: structuredRole,
      content: buildStructuredTextMessage({ role: structuredRole, text: msg.content }),
    };
  }

  const textContent = getMessageTextContent(msg);
  const content = msg.content.map((block) => {
    if (block.type === 'text') {
      return {
        type: 'text',
        text: buildStructuredTextMessage({
          role: structuredRole,
          text: block.text,
        }),
      };
    }
    if (block.type === 'thinking') {
      return {
        type: 'thinking',
        text: buildStructuredTextMessage({ role: structuredRole, text: block.text }),
      };
    }
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
    role: structuredRole,
    content:
      content.length > 0
        ? [...content, ...toolCalls]
        : [
            {
              type: 'text',
              text: buildStructuredTextMessage({
                role: structuredRole,
                text: textContent,
              }),
            },
            ...toolCalls,
          ],
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

function getModelMessageTraceContent(msg: Message): string {
  if (msg.role === 'tool') {
    return getMessageTextContent(msg);
  }

  if (msg.role === 'user' || msg.role === 'assistant') {
    return buildStructuredTextMessage({
      role: msg.role,
      text: getMessageTextContent(msg),
      toolCalls: msg.toolCalls,
    });
  }

  return getMessageTextContent(msg);
}

function isStructuredTextRole(role: Message['role']): role is 'user' | 'assistant' {
  return role === 'user' || role === 'assistant';
}

function truncateTraceContent(content: string): string {
  if (content.length <= TRACE_MESSAGE_CONTENT_LIMIT) return content;

  const marker = '\n\n[...trace content truncated; keeping head and latest tail...]\n\n';
  const headLength = Math.floor((TRACE_MESSAGE_CONTENT_LIMIT - marker.length) / 2);
  const tailLength = TRACE_MESSAGE_CONTENT_LIMIT - marker.length - headLength;
  return content.slice(0, headLength) + marker + content.slice(-tailLength);
}

/**
 * Try to extract tool calls from suncode.message JSON embedded in assistant text.
 * Returns null if no valid tool calls are found.
 */
function tryParseToolCallsFromText(
  text: string,
): { toolCalls: ToolCallContent[]; cleanedText: string } | null {
  // Look for suncode.message JSON — may appear at the start or within the text
  const jsonMatch = text.match(/\{\s*"type"\s*:\s*"suncode\.message"[\s\S]*?\}/);
  if (!jsonMatch) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  const rawToolCalls = parsed.toolCalls as Array<Record<string, unknown>> | undefined;
  if (!rawToolCalls || !Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
    return null;
  }

  const toolCalls: ToolCallContent[] = [];
  for (const tc of rawToolCalls) {
    const id = (tc.id as string) || `fallback_${Date.now()}_${toolCalls.length}`;
    const name = tc.name as string;
    const args = tc.arguments;
    if (!name) continue;
    toolCalls.push({
      type: 'tool_call',
      id,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    });
  }

  if (toolCalls.length === 0) return null;

  // Remove the JSON block from the text to avoid polluting context
  const cleanedText = text.replace(jsonMatch[0], '').trim();

  return { toolCalls, cleanedText };
}

/**
 * Persist the task plan to .suncode/plans/task-current.md in real-time.
 * Called after every turn's stream completes if the assistant text contains
 * a 📋 执行计划：or 📋 进度更新：marker.
 */
function maybeSaveTurnPlan(assistantText: string, workingDir: string, sessionId: string): void {
  try {
    if (!assistantText?.includes('📋')) return;

    // Find the LAST plan marker
    const execIdx = assistantText.lastIndexOf('📋 执行计划：');
    const progIdx = assistantText.lastIndexOf('📋 进度更新：');
    const markerIdx = Math.max(execIdx, progIdx);
    if (markerIdx < 0) return;

    // Extract plan block
    const afterMarker = assistantText.slice(markerIdx);
    const blockEnd = afterMarker.indexOf('\n\n');
    const planBlock = blockEnd >= 0 ? afterMarker.slice(0, blockEnd) : afterMarker;

    const plansDir = getAgentDataSubdir(workingDir, '.suncode/plans', sessionId);
    if (!existsSync(plansDir)) {
      mkdirSync(plansDir, { recursive: true });
    }

    // Always overwrite the same "current" file so the right panel watches a single file
    writeFileSync(join(plansDir, 'task-current.md'), `# Task Plan\n\n${planBlock}\n`, 'utf-8');
  } catch {
    // Best-effort
  }
}

/**
 * Extract the latest 📋 plan block from a turn's assistant text.
 * Returns the block text and inferred task type, or null if no marker.
 */
function extractPlanBlock(
  assistantText: string,
): { text: string; taskType: TaskPlan['taskType'] } | null {
  if (!assistantText?.includes('📋')) return null;
  const execIdx = assistantText.lastIndexOf('📋 执行计划：');
  const progIdx = assistantText.lastIndexOf('📋 进度更新：');
  const markerIdx = Math.max(execIdx, progIdx);
  if (markerIdx < 0) return null;

  const afterMarker = assistantText.slice(markerIdx);
  const blockEnd = afterMarker.indexOf('\n\n');
  const block = blockEnd >= 0 ? afterMarker.slice(0, blockEnd) : afterMarker;
  return { text: block, taskType: 'execution' };
}

/**
 * Parse an accumulated 📋 plan block into a TaskPlan structure (non-streaming).
 * Mirrors the renderer's task-plan-parser so the final message can carry a
 * structured plan that survives multi-turn runs.
 */
function parsePlanBlockToTaskPlan(
  planBlock: string,
  taskType: TaskPlan['taskType'],
): TaskPlan | null {
  const steps: TaskStep[] = [];
  const strictRegex = /^\s*[-*+]\s+\[([ xX])\]\s+Step\s+(\d+):\s*(.+)\$/gm;
  const looseRegex = /^\s*[-*+]\s+\[([ xX])\]\s*(.+)\$/gm;

  let match: RegExpExecArray | null = strictRegex.exec(planBlock);
  while (match !== null) {
    const status: TaskStep['status'] =
      (match[1] ?? '').trim().toLowerCase() === 'x' ? 'done' : 'pending';
    const stepNum = parseInt(match[2] ?? '', 10);
    const raw = (match[3] ?? '').trim();
    const { description, result } = splitStepResult(raw);
    steps.push({ id: `step_${stepNum}`, index: stepNum, description, status, result });
    match = strictRegex.exec(planBlock);
  }

  if (steps.length === 0) {
    let autoIndex = 0;
    match = looseRegex.exec(planBlock);
    while (match !== null) {
      const status: TaskStep['status'] =
        (match[1] ?? '').trim().toLowerCase() === 'x' ? 'done' : 'pending';
      const raw = (match[2] ?? '').trim();
      autoIndex++;
      const numMatch = raw.match(/^(?:Step\s*)?(\d+)[.、:：]\s*/);
      let index: number;
      let descStart: number;
      if (numMatch) {
        index = parseInt(numMatch[1] ?? '', 10);
        descStart = numMatch[0]?.length ?? 0;
      } else {
        index = autoIndex;
        descStart = 0;
      }
      const { description, result } = splitStepResult(raw.slice(descStart));
      steps.push({ id: `step_${index}`, index, description, status, result });
      match = looseRegex.exec(planBlock);
    }
  }

  if (steps.length === 0) return null;
  return { taskType, steps };
}

function splitStepResult(raw: string): { description: string; result?: string } {
  const emdashIdx = raw.indexOf(' — ');
  if (emdashIdx > 0) {
    return {
      description: raw.slice(0, emdashIdx).trim(),
      result: raw.slice(emdashIdx + 3).trim(),
    };
  }
  const colonIdx = raw.indexOf('：');
  if (colonIdx > 4 && colonIdx < raw.length - 3) {
    return {
      description: raw.slice(0, colonIdx).trim(),
      result: raw.slice(colonIdx + 1).trim(),
    };
  }
  return { description: raw };
}

/** Build a TaskPlan from the accumulated plan block, if any. */
function buildAccumulatedTaskPlan(
  planBlock: string,
  taskType: TaskPlan['taskType'],
): TaskPlan | undefined {
  if (!planBlock) return undefined;
  return parsePlanBlockToTaskPlan(planBlock, taskType) ?? undefined;
}
