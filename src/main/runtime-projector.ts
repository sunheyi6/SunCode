import {
  RUNTIME_PROJECTION_VERSION,
  type RuntimeEvent,
  type RuntimeProjectionCursor,
} from '@shared/runtime-events';
import type { Message, ToolCallContent, TurnDetail } from '@shared/types';

interface RunProjectionState {
  systemPrompt?: string;
  hasVisibleUserMessage: boolean;
  turnDetails: TurnDetail[];
  toolCalls: ToolCallContent[];
}

export interface SessionRuntimeProjection {
  messages: Message[];
  cursor: RuntimeProjectionCursor;
}

export interface InvocationRuntimeState {
  runId: string;
  status: 'running' | 'stop_requested' | 'completed' | 'failed' | 'aborted' | 'interrupted';
  terminalEventId?: string;
}

function runState(states: Map<string, RunProjectionState>, runId: string): RunProjectionState {
  let state = states.get(runId);
  if (!state) {
    state = { hasVisibleUserMessage: false, turnDetails: [], toolCalls: [] };
    states.set(runId, state);
  }
  return state;
}

function cloneMessage(message: Message): Message {
  return structuredClone(message);
}

/** Deterministically rebuild the compatibility Message[] view from semantic facts. */
export function projectSessionRuntime(events: RuntimeEvent[]): SessionRuntimeProjection {
  let messages: Message[] = [];
  const runs = new Map<string, RunProjectionState>();
  let latestUiLanguage: Message['uiLanguage'];

  for (const event of events) {
    const runId = event.runId;
    switch (event.fact.type) {
      case 'legacy_snapshot_imported':
        messages = event.fact.messages.map(cloneMessage);
        latestUiLanguage = [...messages]
          .reverse()
          .find((message) => message.role === 'user')?.uiLanguage;
        break;
      case 'conversation_cleared':
        messages = [];
        latestUiLanguage = undefined;
        break;
      case 'user_message_committed':
        messages.push(cloneMessage(event.fact.message));
        if (runId) runState(runs, runId).hasVisibleUserMessage = true;
        if (event.fact.message.uiLanguage !== undefined) {
          latestUiLanguage = event.fact.message.uiLanguage;
        }
        break;
      case 'system_prompt_committed':
        if (runId) runState(runs, runId).systemPrompt = event.fact.systemPrompt;
        break;
      case 'model_step_committed':
        if (runId) {
          const state = runState(runs, runId);
          const detail: TurnDetail = {
            turnNumber: event.fact.stepIndex,
            systemTokens: event.fact.systemTokens,
            requestMessages: event.fact.requestMessages,
            response: {
              text: event.fact.responseText,
              thinking: event.fact.responseThinking,
              toolCalls: event.fact.responseToolCalls,
              stopReason: event.fact.stopReason,
              inputTokens: event.fact.inputTokens,
              outputTokens: event.fact.outputTokens,
              totalTokens: event.fact.totalTokens,
            },
          };
          const existingIndex = state.turnDetails.findIndex(
            (candidate) => candidate.turnNumber === detail.turnNumber,
          );
          if (existingIndex >= 0) state.turnDetails[existingIndex] = detail;
          else state.turnDetails.push(detail);
        }
        break;
      case 'tool_call_committed':
        if (runId) {
          const state = runState(runs, runId);
          const committedToolCall = event.fact.toolCall;
          if (!state.toolCalls.some((toolCall) => toolCall.id === committedToolCall.id)) {
            state.toolCalls.push(structuredClone(committedToolCall));
          }
        }
        break;
      case 'tool_result_committed':
        if (runId) {
          const state = runState(runs, runId);
          const committedToolResult = event.fact.toolResult;
          const toolCall = state.toolCalls.find(
            (candidate) => candidate.id === committedToolResult.toolCallId,
          );
          if (toolCall) {
            toolCall.status = committedToolResult.success ? 'done' : 'error';
            toolCall.result = structuredClone(committedToolResult);
          }
        }
        break;
      case 'assistant_message_committed': {
        const state = runId ? runs.get(runId) : undefined;
        const message = cloneMessage(event.fact.message);
        if (message.uiLanguage === undefined) message.uiLanguage = latestUiLanguage;
        if (state?.systemPrompt !== undefined) message.systemPrompt = state.systemPrompt;
        if (state && state.turnDetails.length > 0) {
          message.turnDetails = structuredClone(state.turnDetails);
        }
        if (state && state.toolCalls.length > 0)
          message.toolCalls = structuredClone(state.toolCalls);
        const lastMessage = messages.at(-1);
        if (!state?.hasVisibleUserMessage && lastMessage?.role === 'assistant') {
          messages[messages.length - 1] = { ...lastMessage, ...message };
        } else {
          messages.push(message);
        }
        break;
      }
      case 'permission_requested':
      case 'permission_decided':
      case 'invocation_stop_requested':
      case 'invocation_terminated':
        break;
    }
  }

  const last = events.at(-1);
  return {
    messages,
    cursor: {
      version: RUNTIME_PROJECTION_VERSION,
      lastEventId: last?.eventId,
      lastSequence: last?.sequence ?? 0,
    },
  };
}

/** Current compatibility policy intentionally preserves the existing Message[] request shape. */
export function projectModelHistory(events: RuntimeEvent[]): Message[] {
  // projectSessionRuntime already clones messages into a fresh array.
  return projectSessionRuntime(events).messages;
}

/** Classify invocation state from semantic facts without consulting run headers or UI state. */
export function projectInvocationStates(
  events: RuntimeEvent[],
): Map<string, InvocationRuntimeState> {
  const states = new Map<string, InvocationRuntimeState>();
  for (const event of events) {
    const runId = event.invocationId;
    if (!runId) continue;
    const existing = states.get(runId) ?? { runId, status: 'running' as const };
    if (event.fact.type === 'invocation_stop_requested') {
      if (existing.status === 'running') existing.status = 'stop_requested';
    } else if (event.fact.type === 'invocation_terminated') {
      existing.status = event.fact.status;
      existing.terminalEventId = event.eventId;
    }
    states.set(runId, existing);
  }
  return states;
}

/** Open invocations: started in the ledger but not yet terminated. */
export function findOpenInvocationIds(events: RuntimeEvent[]): string[] {
  return [...projectInvocationStates(events).values()]
    .filter((state) => state.status === 'running' || state.status === 'stop_requested')
    .map((state) => state.runId);
}

export function wasInvocationStopRequested(events: RuntimeEvent[], runId: string): boolean {
  return events.some(
    (event) => event.invocationId === runId && event.fact.type === 'invocation_stop_requested',
  );
}

export function invocationHasAssistantMessage(events: RuntimeEvent[], runId: string): boolean {
  return events.some(
    (event) => event.invocationId === runId && event.fact.type === 'assistant_message_committed',
  );
}

export function projectionCursorMatches(
  cursor: RuntimeProjectionCursor | undefined,
  projected: RuntimeProjectionCursor,
): boolean {
  return (
    cursor?.version === projected.version &&
    cursor?.lastEventId === projected.lastEventId &&
    cursor?.lastSequence === projected.lastSequence
  );
}
