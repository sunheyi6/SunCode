import type { Message, RequestMessageTrace, ToolCallContent, ToolResult } from './types';

export const RUNTIME_EVENT_PROTOCOL_VERSION = 1;
export const RUNTIME_PROJECTION_VERSION = 1;

export type RuntimeTerminationStatus = 'completed' | 'failed' | 'aborted' | 'interrupted';

export type RuntimeEventFact =
  | { type: 'legacy_snapshot_imported'; messages: Message[] }
  | {
      type: 'user_message_committed';
      message: Message;
      source: 'dispatch' | 'guidance' | 'recovery';
    }
  | { type: 'system_prompt_committed'; systemPrompt: string }
  | {
      type: 'model_step_committed';
      stepIndex: number;
      attempt: number;
      provider: string;
      model: string;
      requestMessages: RequestMessageTrace[];
      systemTokens: number;
      responseText: string;
      responseThinking: string;
      responseToolCalls: ToolCallContent[];
      stopReason?: string;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }
  | { type: 'tool_call_committed'; toolCall: ToolCallContent }
  | { type: 'tool_result_committed'; toolResult: ToolResult }
  | { type: 'permission_requested'; toolCall: ToolCallContent }
  | { type: 'permission_decided'; toolCallId: string; allowed: boolean }
  | { type: 'invocation_stop_requested'; source: 'hard_stop' | 'soft_stop' }
  | { type: 'assistant_message_committed'; message: Message }
  | {
      type: 'invocation_terminated';
      status: RuntimeTerminationStatus;
      finalMessageEventId?: string;
      reason?: string;
    }
  | {
      type: 'compaction_applied';
      turnNumber: number;
      mode: 'shadow' | 'replace';
      projectionId: string;
      previousProjectionId?: string;
      sourceDigest: string;
      /** 被替换源消息在请求视图中的索引范围（含端点），replace 模式下存在。 */
      sourceStartIndex?: number;
      sourceEndIndex?: number;
      /** 投影消息完整内容（contextKind='semantic_projection'），replace 模式下存在。 */
      projectionMessage?: Message;
    }
  | { type: 'conversation_cleared' };

/**
 * Immutable semantic fact stored in a session's Runtime Event Log.
 * Sequence and previousEventId provide a deterministic total order within the session.
 */
export interface RuntimeEvent {
  protocolVersion: number;
  eventId: string;
  sequence: number;
  timestamp: string;
  previousEventId?: string;
  sessionId: string;
  turnId?: string;
  runId?: string;
  invocationId?: string;
  partial: false;
  fact: RuntimeEventFact;
}

export interface RuntimeEventDraft {
  eventId?: string;
  timestamp?: string;
  turnId?: string;
  runId?: string;
  invocationId?: string;
  fact: RuntimeEventFact;
}

export interface RuntimeProjectionCursor {
  version: number;
  lastEventId?: string;
  lastSequence: number;
}
