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
  abortSignal: AbortSignal;
  /** Unique identifier for this run (used for event logging). */
  runId: string;
  /** Stable session identifier for prompt cache affinity. */
  sessionId: string;
  onStream: (event: StreamEvent) => void;
  onToolStart: (toolCall: ToolCallContent) => void;
  onToolEnd: (result: ToolResult) => void;
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
  onTurnStart?: (turnCount: number, maxTurns: number, tokenUsage: { input: number; output: number; total: number }) => void;
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
    abortSignal,
    runId,
    sessionId,
    onStream,
    onToolStart,
    onToolEnd,
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
      // Import pi-ai dynamically
      let streamSimpleFn: (
        model: unknown,
        context: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => AsyncIterable<AssistantMessageEvent>;
      try {
        const pi = await import('@earendil-works/pi-ai');
        streamSimpleFn = pi.streamSimple as unknown as typeof streamSimpleFn;
        if (!streamSimpleFn) {
          throw new Error('streamSimple not found in pi-ai exports');
        }
      } catch (importErr) {
        console.error('[AgentLoop] Failed to import pi-ai:', importErr);
        throw new Error(
          `无法加载 AI 库：${(importErr as Error).message}。请确保已安装 @earendil-works/pi-ai。`,
        );
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
        const contentStr =
          typeof m.content === 'string'
            ? m.content
            : m.content
                .filter((b) => b.type === 'text' || b.type === 'thinking')
                .map((b) => ('text' in b ? b.text : ''))
                .join('\n');
        diag.log('LLM_REQUEST_INPUT', `[msg-${mi}] role=${m.role} len=${contentStr.length}`, {
          content: contentStr,
        });
      }

      // Accumulate content as it streams in
      let assistantText = '';
      const toolCalls: ToolCallContent[] = [];
      let thinkingText = '';
      let assistantMsgRaw: Record<string, unknown> | null = null;

      // Capture request message summaries for turn_detail event
      const requestMsgSummaries = lastMsgsForLog.map((m) => {
        const contentStr =
          typeof m.content === 'string'
            ? m.content
            : m.content
                .filter((b) => b.type === 'text' || b.type === 'thinking')
                .map((b) => ('text' in b ? b.text : ''))
                .join('\n');
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

      let requestError: string | undefined;

      try {
        const stream = streamSimpleFn(model, piContext, {
          reasoning: settings.thinkingLevel,
          signal: abortSignal,
          cacheRetention: 'long',
          sessionId,
        });

        // Emit message_start once at the beginning
        onStream({ type: 'message_start' });

        for await (const event of stream) {
          switch (event.type) {
            case 'start':
            case 'text_start':
            case 'thinking_start':
            case 'thinking_end':
              // No-op: we emit assembled state via message_update
              break;
            case 'text_delta':
              assistantText += event.delta;
              onStream({
                type: 'message_update',
                data: {
                  text: assistantText,
                  thinking: thinkingText,
                  toolCalls: [...toolCalls],
                },
              });
              break;
            case 'text_end':
              break;
            case 'thinking_delta':
              thinkingText += event.delta;
              onStream({
                type: 'message_update',
                data: {
                  text: assistantText,
                  thinking: thinkingText,
                  toolCalls: [...toolCalls],
                },
              });
              break;
            case 'toolcall_start':
              // No-op: toolcall is added/updated on toolcall_end
              break;
            case 'toolcall_delta':
              // No-op: arguments are accumulated locally
              break;
            case 'toolcall_end': {
              const tc: ToolCallContent = {
                type: 'tool_call',
                id: event.toolCall.id,
                name: event.toolCall.name,
                arguments: JSON.stringify(event.toolCall.arguments),
              };
              toolCalls.push(tc);
              onStream({
                type: 'message_update',
                data: {
                  text: assistantText,
                  thinking: thinkingText,
                  toolCalls: [...toolCalls],
                },
              });
              break;
            }
            case 'done':
              assistantMsgRaw = event.message as unknown as Record<string, unknown>;
              if (event.message.usage) {
                tokenUsage.input += event.message.usage.input || 0;
                tokenUsage.output += event.message.usage.output || 0;
                tokenUsage.total += event.message.usage.totalTokens || 0;
              }
              break;
            case 'error': {
              if (event.reason === 'aborted') {
                const err = new Error('已中止') as Error & { name: string };
                err.name = 'AbortError';
                throw err;
              }
              const errMsg =
                ((event.error as unknown as Record<string, unknown>)?.errorMessage as string) ||
                'LLM stream error';
              throw new Error(errMsg);
            }
          }
        }

        console.log(`[AgentLoop] Stream done:`, {
          assistantTextLen: assistantText.length,
          thinkingTextLen: thinkingText.length,
          toolCalls: toolCalls.length,
          stopReason: assistantMsgRaw?.stopReason,
        });
        diag.exit(
          'LLM',
          `${assistantText.length}chars ${thinkingText.length}thinking ${toolCalls.length}tools`,
          { stopReason: assistantMsgRaw?.stopReason },
        );

        // Log full assistant text and thinking for post-mortem
        if (assistantText) {
          diag.log('LLM_RESPONSE_TEXT', `len=${assistantText.length}`, { content: assistantText });
        }
        if (thinkingText) {
          diag.log('LLM_RESPONSE_THINKING', `len=${thinkingText.length}`, {
            content: thinkingText,
          });
        }

        // Emit enriched run event with request/response content for call trace panel
        const durationMs = Date.now() - requestStartTime;
        const usage = assistantMsgRaw?.usage as
          | { input?: number; output?: number; totalTokens?: number }
          | undefined;
        onRunEvent({
          type: 'model_request_completed',
          runId,
          turnNumber: turnCount,
          attempt: requestAttempt,
          provider: settings.activeProvider,
          model: settings.activeModel,
          durationMs,
          inputTokens: usage?.input,
          outputTokens: usage?.output,
          totalTokens: usage?.totalTokens,
          stopReason: assistantMsgRaw?.stopReason as string | undefined,
          error: requestError,
          timestamp: '',
          requestMessages: requestMsgSummaries,
          systemTokens: Math.round(systemPrompt.length / 3.5),
          responseText: assistantText,
          responseThinking: thinkingText,
          responseToolCalls: [...toolCalls],
        });
      } catch (streamErr) {
        if (!requestError) {
          requestError = (streamErr as Error).message;
        }
        throw streamErr;
      }

      // Check for empty response
      if (!assistantText && toolCalls.length === 0 && !thinkingText) {
        console.error(
          `[AgentLoop] Empty response from ${settings.activeProvider}/${settings.activeModel}` +
            ` on turn ${turnCount}. assistantTextLen=${assistantText.length}` +
            ` toolCalls=${toolCalls.length} thinkingLen=${thinkingText.length}` +
            ` stopReason=${assistantMsgRaw?.stopReason || 'none'}`,
        );
        diag.log('LLM', 'empty_response', { stopReason: assistantMsgRaw?.stopReason });
        throw new Error(
          `模型 ${settings.activeProvider}/${settings.activeModel} 返回了空响应（stopReason=${assistantMsgRaw?.stopReason || 'none'}），请检查 API Key、额度和模型权限。`,
        );
      }

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

      // Execute tool calls (parallel when multiple independent calls)
      console.log(`[AgentLoop] Executing ${toolCalls.length} tool calls`);

      if (abortSignal.aborted) {
        const err2 = new Error('已中止') as Error & { name: string };
        err2.name = 'AbortError';
        throw err2;
      }

      // Phase 1: Validate all tools synchronously, emit start events
      interface ValidatedCall {
        tc: (typeof toolCalls)[number];
        tool: Tool;
        params: Record<string, unknown>;
      }
      const toolResults: ToolResult[] = [];
      const toExecute: ValidatedCall[] = [];

      for (const tc of toolCalls) {
        onToolStart(tc);
        onRunEvent({
          type: 'tool_started',
          runId,
          toolCallId: tc.id,
          toolName: tc.name,
          timestamp: '',
        });

        const tool = tools.find((t) => t.name === tc.name);
        if (!tool) {
          const e: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            success: false,
            error: `未知工具: ${tc.name}`,
            output: '',
          };
          toolResults.push(e);
          onToolEnd(e);
          onRunEvent({
            type: 'tool_completed',
            runId,
            toolCallId: tc.id,
            toolName: tc.name,
            success: false,
            timestamp: '',
          });
          console.warn(`[AgentLoop] Unknown tool: ${tc.name}`);
          continue;
        }

        let params: Record<string, unknown>;
        try {
          params = JSON.parse(tc.arguments);
        } catch {
          const e: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            success: false,
            error: `Validation failed for tool "${tc.name}": JSON parse error in arguments.\n\nReceived arguments:\n${tc.arguments}`,
            output: '',
          };
          toolResults.push(e);
          onToolEnd(e);
          onRunEvent({
            type: 'tool_completed',
            runId,
            toolCallId: tc.id,
            toolName: tc.name,
            success: false,
            timestamp: '',
          });
          continue;
        }

        // Validate required parameters
        {
          const def = tool.getDefinition();
          const required = (def.parameters as { required?: string[] }).required ?? [];
          const props =
            (def.parameters as { properties?: Record<string, { type: string }> }).properties ?? {};
          let missing: string | null = null;
          for (const key of required) {
            if (params[key] === undefined || params[key] === null) {
              missing = key;
              break;
            }
            if (props[key]?.type === 'integer' && typeof params[key] === 'string') {
              const n = Number(params[key]);
              if (Number.isFinite(n)) params[key] = n;
            }
          }
          if (missing) {
            const formatted = `Validation failed for tool "${tc.name}":\n  - ${missing}: Required property\n\nReceived arguments:\n${JSON.stringify(params, null, 2)}`;
            const e: ToolResult = {
              toolCallId: tc.id,
              name: tc.name,
              success: false,
              error: formatted,
              output: '',
            };
            toolResults.push(e);
            onToolEnd(e);
            onRunEvent({
              type: 'tool_completed',
              runId,
              toolCallId: tc.id,
              toolName: tc.name,
              success: false,
              timestamp: '',
            });
            continue;
          }
        }

        // -- Permission: confirm destructive tools --
        if (
          settings.permissionMode === 'confirm_changes' &&
          !tool.isReadonly &&
          requestConfirmation
        ) {
          const confirmed = await requestConfirmation(tc);
          if (!confirmed) {
            const skipped: ToolResult = {
              toolCallId: tc.id,
              name: tc.name,
              success: false,
              error: '用户取消了此操作',
              output: '',
            };
            toolResults.push(skipped);
            onToolEnd(skipped);
            onRunEvent({
              type: 'tool_completed',
              runId,
              toolCallId: tc.id,
              toolName: tc.name,
              success: false,
              timestamp: '',
            });
            continue;
          }
        }

        toExecute.push({ tc, tool, params });
      }

      // Phase 2: Execute all valid tools in parallel
      if (toExecute.length > 0) {
        const mode = toExecute.length > 1 ? 'parallel' : 'single';
        const toolExecStartTime = Date.now();
        console.log(
          `[AgentLoop] Executing ${toExecute.length} tools in ${mode}:` +
            ` [${toExecute.map((t) => t.tc.name).join(', ')}]`,
        );

        const settled = await Promise.allSettled(
          toExecute.map(async ({ tc, tool, params }) => {
            const tStart = Date.now();
            try {
              const paramsStr = JSON.stringify(params);
              const paramsPreview =
                paramsStr.length > 100 ? `${paramsStr.slice(0, 100)}...` : paramsStr;
              console.log(`[AgentLoop] Tool ${tc.name} executing (params: ${paramsPreview})`);
              const result = await tool.execute(params);
              result.toolCallId = tc.id;
              onToolEnd(result);
              onRunEvent({
                type: 'tool_completed',
                runId,
                toolCallId: tc.id,
                toolName: tc.name,
                success: result.success,
                timestamp: '',
              });
              console.log(
                `[AgentLoop] Tool ${tc.name}: ${result.success ? 'OK' : 'FAIL'}` +
                  ` (${Date.now() - tStart}ms)` +
                  `${result.error ? ` — ${result.error.slice(0, 80)}` : ''}`,
              );
              diag.log('TOOL', `${tc.name} ${result.success ? 'OK' : 'FAIL'}`, {
                durationMs: Date.now() - tStart,
                success: result.success,
                ...(result.error ? { error: result.error.slice(0, 80) } : {}),
              });
              return result;
            } catch (error) {
              const e: ToolResult = {
                toolCallId: tc.id,
                name: tc.name,
                success: false,
                error: (error as Error).message,
                output: '',
              };
              onToolEnd(e);
              onRunEvent({
                type: 'tool_completed',
                runId,
                toolCallId: tc.id,
                toolName: tc.name,
                success: false,
                timestamp: '',
              });
              console.log(
                `[AgentLoop] Tool ${tc.name}: CRASH (${Date.now() - tStart}ms) — ${(error as Error).message.slice(0, 80)}`,
              );
              diag.log('TOOL', `${tc.name} CRASH`, {
                durationMs: Date.now() - tStart,
                error: (error as Error).message.slice(0, 80),
              });
              return e;
            }
          }),
        );

        for (const s of settled) {
          if (s.status === 'fulfilled') {
            toolResults.push(s.value);
          } else {
            toolResults.push({
              toolCallId: '',
              name: 'unknown',
              success: false,
              error: `内部错误: ${s.reason}`,
              output: '',
            });
          }
        }

        console.log(
          `[AgentLoop] Tools done: ${toolResults.filter((t) => t.success).length}/${toolResults.length} OK` +
            ` (total ${Date.now() - toolExecStartTime}ms)`,
        );
        diag.exit(
          'TOOLS',
          `${toolResults.filter((t) => t.success).length}/${toolResults.length} OK`,
          { durationMs: Date.now() - toolExecStartTime },
        );
      }

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
    role: msg.role === 'tool' ? 'user' : msg.role,
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
