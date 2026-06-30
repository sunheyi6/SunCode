import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { ToolCallContent, StreamEvent, RunEvent, AppSettings } from '@shared/types';
import type { DiagLogger } from '../utils/diag-logger';

export interface StreamHandlerInput {
  stream: AsyncIterable<AssistantMessageEvent>;
  onStream: (event: StreamEvent) => void;
  onRunEvent: (event: RunEvent) => void;
  diag: DiagLogger;
  settings: AppSettings;
  systemPrompt: string;
  runId: string;
  turnCount: number;
  requestAttempt: number;
  requestStartTime: number;
  requestMsgSummaries: { role: string; length: number; preview: string }[];
  /** Optional: called immediately when a tool_use block is complete during streaming. */
  onToolCallComplete?: (toolCall: ToolCallContent) => void;
}

export interface StreamHandlerOutput {
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallContent[];
  assistantMsgRaw: Record<string, unknown> | null;
  tokenUsage: { input: number; output: number; total: number };
}

export async function handleStream(input: StreamHandlerInput): Promise<StreamHandlerOutput> {
  const {
    stream,
    onStream,
    onRunEvent,
    diag,
    settings,
    systemPrompt,
    runId,
    turnCount,
    requestAttempt,
    requestStartTime,
    requestMsgSummaries,
    onToolCallComplete,
  } = input;

  let assistantText = '';
  const toolCalls: ToolCallContent[] = [];
  let thinkingText = '';
  let assistantMsgRaw: Record<string, unknown> | null = null;
  const tokenUsage = { input: 0, output: 0, total: 0 };
  let firstTokenTime: number | undefined;

  onStream({ type: 'message_start' });

  for await (const event of stream) {
    switch (event.type) {
      case 'start':
      case 'text_start':
      case 'thinking_start':
      case 'thinking_end':
        break;
      case 'text_delta':
        firstTokenTime = firstTokenTime ?? Date.now();
        assistantText += event.delta;
        onRunEvent({
          type: 'content.part',
          runId,
          turnNumber: turnCount,
          part: { kind: 'text', text: event.delta },
          timestamp: '',
        });
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
        firstTokenTime = firstTokenTime ?? Date.now();
        thinkingText += event.delta;
        onRunEvent({
          type: 'content.part',
          runId,
          turnNumber: turnCount,
          part: { kind: 'thinking', thinking: event.delta },
          timestamp: '',
        });
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
        break;
      case 'toolcall_delta':
        break;
      case 'toolcall_end': {
        const tc: ToolCallContent = {
          type: 'tool_call',
          id: event.toolCall.id,
          name: event.toolCall.name,
          arguments: JSON.stringify(event.toolCall.arguments),
        };
        toolCalls.push(tc);

        // Notify streaming executor immediately — don't wait for stream to end
        onToolCallComplete?.(tc);

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

  if (assistantText) {
    diag.log('LLM_RESPONSE_TEXT', `len=${assistantText.length}`, { content: assistantText });
  }
  if (thinkingText) {
    diag.log('LLM_RESPONSE_THINKING', `len=${thinkingText.length}`, {
      content: thinkingText,
    });
  }

  const durationMs = Date.now() - requestStartTime;
  const firstTokenLatencyMs =
    firstTokenTime === undefined ? undefined : firstTokenTime - requestStartTime;
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
    firstTokenLatencyMs,
    streamDurationMs:
      firstTokenLatencyMs === undefined ? undefined : durationMs - firstTokenLatencyMs,
    inputTokens: usage?.input,
    outputTokens: usage?.output,
    totalTokens: usage?.totalTokens,
    stopReason: assistantMsgRaw?.stopReason as string | undefined,
    error: undefined,
    timestamp: '',
    requestMessages: requestMsgSummaries,
    systemTokens: Math.round(systemPrompt.length / 3.5),
    responseText: assistantText,
    responseThinking: thinkingText,
    responseToolCalls: [...toolCalls],
  });

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

  return {
    assistantText,
    thinkingText,
    toolCalls,
    assistantMsgRaw,
    tokenUsage,
  };
}
