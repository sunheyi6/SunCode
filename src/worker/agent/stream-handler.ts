import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { sanitizeStructuredMessageLeakStreaming } from '@shared/finalization';
import type {
  AppSettings,
  RequestMessageTrace,
  RunEvent,
  StreamEvent,
  ToolCallContent,
} from '@shared/types';
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
  requestMsgSummaries: RequestMessageTrace[];
  requestKind?: 'main' | 'semantic_compact';
  emitToStream?: boolean;
  /** Optional: called immediately when a tool_use block is complete during streaming. */
  onToolCallComplete?: (toolCall: ToolCallContent) => void;
}

export interface StreamHandlerOutput {
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallContent[];
  assistantMsgRaw: Record<string, unknown> | null;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
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
    requestKind = 'main',
    emitToStream = true,
    onToolCallComplete,
  } = input;

  let assistantText = '';
  const toolCalls: ToolCallContent[] = [];
  let thinkingText = '';
  let assistantMsgRaw: Record<string, unknown> | null = null;
  const tokenUsage = {
    input: 0,
    output: 0,
    total: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  let firstTokenTime: number | undefined;

  if (emitToStream) onStream({ type: 'message_start' });

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
        if (emitToStream) {
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
              text: sanitizeStructuredMessageLeakStreaming(assistantText),
              thinking: thinkingText,
              toolCalls: [...toolCalls],
            },
          });
        }
        break;
      case 'text_end':
        break;
      case 'thinking_delta':
        firstTokenTime = firstTokenTime ?? Date.now();
        thinkingText += event.delta;
        if (emitToStream) {
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
              text: sanitizeStructuredMessageLeakStreaming(assistantText),
              thinking: thinkingText,
              toolCalls: [...toolCalls],
            },
          });
        }
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

        if (emitToStream) {
          onStream({
            type: 'message_update',
            data: {
              text: sanitizeStructuredMessageLeakStreaming(assistantText),
              thinking: thinkingText,
              toolCalls: [...toolCalls],
            },
          });
        }
        break;
      }
      case 'done':
        assistantMsgRaw = event.message as unknown as Record<string, unknown>;
        if (event.message.usage) {
          tokenUsage.input += event.message.usage.input || 0;
          tokenUsage.output += event.message.usage.output || 0;
          tokenUsage.total += event.message.usage.totalTokens || 0;
          tokenUsage.cacheRead += event.message.usage.cacheRead || 0;
          tokenUsage.cacheWrite += event.message.usage.cacheWrite || 0;
          tokenUsage.cacheWrite1h += event.message.usage.cacheWrite1h || 0;
          tokenUsage.cost.input += event.message.usage.cost?.input || 0;
          tokenUsage.cost.output += event.message.usage.cost?.output || 0;
          tokenUsage.cost.cacheRead += event.message.usage.cost?.cacheRead || 0;
          tokenUsage.cost.cacheWrite += event.message.usage.cost?.cacheWrite || 0;
          tokenUsage.cost.total += event.message.usage.cost?.total || 0;
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
    | {
        input?: number;
        output?: number;
        totalTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cacheWrite1h?: number;
        cost?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          total?: number;
        };
      }
    | undefined;
  onRunEvent({
    type: 'model_request_completed',
    runId,
    turnNumber: turnCount,
    attempt: requestAttempt,
    provider: settings.activeProvider,
    model: settings.activeModel,
    requestKind,
    durationMs,
    firstTokenLatencyMs,
    streamDurationMs:
      firstTokenLatencyMs === undefined ? undefined : durationMs - firstTokenLatencyMs,
    inputTokens: usage?.input,
    outputTokens: usage?.output,
    totalTokens: usage?.totalTokens,
    cacheReadTokens: usage?.cacheRead,
    cacheWriteTokens: usage?.cacheWrite,
    cacheWrite1hTokens: usage?.cacheWrite1h,
    inputCost: usage?.cost?.input,
    outputCost: usage?.cost?.output,
    cacheReadCost: usage?.cost?.cacheRead,
    cacheWriteCost: usage?.cost?.cacheWrite,
    totalCost: usage?.cost?.total,
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
