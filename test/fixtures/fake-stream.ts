/**
 * Fake LLM stream — pi "MockAssistantStream" pattern.
 *
 * Simulates streaming LLM responses for testing agent loops without
 * making real API calls. Supports configurable tool calls, thinking text,
 * delays, and abort behavior.
 */
import { vi } from 'vitest';
import type { AssistantMessageEvent, AssistantMessage, Model } from '@earendil-works/pi-ai';

// ── Model stub ──

export function createFakeModel(overrides?: Partial<Model<'anthropic-messages'>>): Model<'anthropic-messages'> {
  return {
    id: 'test-model',
    name: 'Test Model',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: false,
    input: ['text'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 8_192,
    ...overrides,
  } as Model<'anthropic-messages'>;
}

// ── Usage stub ──

export function createFakeUsage(overrides?: Partial<AssistantMessage['usage']>): AssistantMessage['usage'] {
  return {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0.0003, output: 0.00075, cacheRead: 0, cacheWrite: 0, total: 0.00105 },
    ...overrides,
  };
}

// ── Event factories ──

let eventSeq = 0;

function resetEventSeq(): void {
  eventSeq = 0;
}

function nextContentIndex(): number {
  return eventSeq++;
}

export function createStartEvent(): AssistantMessageEvent {
  return {
    type: 'start',
    partial: {
      role: 'assistant',
      content: [],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'test-model',
      usage: createFakeUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  };
}

export function createTextDelta(text: string): AssistantMessageEvent {
  return {
    type: 'text_delta',
    contentIndex: nextContentIndex(),
    delta: text,
    partial: { role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'test-model', usage: createFakeUsage(), stopReason: 'stop', timestamp: Date.now() },
  };
}

export function createTextEnd(text: string): AssistantMessageEvent {
  return {
    type: 'text_end',
    contentIndex: nextContentIndex(),
    content: text,
    partial: { role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'test-model', usage: createFakeUsage(), stopReason: 'stop', timestamp: Date.now() },
  };
}

export function createToolCallStart(id: string, name: string): AssistantMessageEvent {
  return {
    type: 'toolcall_start',
    contentIndex: nextContentIndex(),
    partial: { role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'test-model', usage: createFakeUsage(), stopReason: 'toolUse', timestamp: Date.now() },
  };
}

export function createToolCallEnd(id: string, name: string, args: Record<string, unknown> = {}): AssistantMessageEvent {
  return {
    type: 'toolcall_end',
    contentIndex: nextContentIndex(),
    toolCall: { type: 'toolCall', id, name, arguments: args },
    partial: { role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'test-model', usage: createFakeUsage(), stopReason: 'toolUse', timestamp: Date.now() },
  };
}

export function createDoneEvent(): AssistantMessageEvent {
  return {
    type: 'done',
    reason: 'stop',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'test-model',
      usage: createFakeUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  };
}

export function createErrorEvent(message = 'Test error'): AssistantMessageEvent {
  return {
    type: 'error',
    reason: 'error',
    error: {
      role: 'assistant',
      content: [],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'test-model',
      errorMessage: message,
      usage: createFakeUsage(),
      stopReason: 'error',
      timestamp: Date.now(),
    },
  };
}

// ── Stream simulator (pi MockAssistantStream pattern) ──

export interface StreamScenario {
  /** Events to emit in order. */
  events: AssistantMessageEvent[];
  /** Delay between events in ms (default 0). */
  interEventDelay?: number;
  /** If true, never emits 'done' — simulates an endless stream (for abort tests). */
  endless?: boolean;
  /** Called when stream iteration starts. */
  onStart?: () => void;
  /** Called when stream iteration ends (done or error). */
  onEnd?: () => void;
}

export async function* createFakeStream(
  scenario: StreamScenario,
  signal?: AbortSignal,
): AsyncIterable<AssistantMessageEvent> {
  resetEventSeq();
  scenario.onStart?.();

  for (const event of scenario.events) {
    if (signal?.aborted) {
      yield {
        type: 'error',
        reason: 'aborted',
        error: {
          role: 'assistant',
          content: [],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'test-model',
          errorMessage: 'Aborted',
          usage: createFakeUsage(),
          stopReason: 'aborted',
          timestamp: Date.now(),
        },
      };
      scenario.onEnd?.();
      return;
    }

    if (scenario.interEventDelay) {
      await new Promise((r) => setTimeout(r, scenario.interEventDelay));
    }
    yield event;
  }

  if (!scenario.endless) {
    scenario.onEnd?.();
  }
}

// ── Pre-built scenarios ──

/** Simple text-only response: "Hello, world!". */
export const simpleTextScenario: StreamScenario = {
  events: [
    createStartEvent(),
    createTextDelta('Hello'),
    createTextDelta(', world!'),
    createTextEnd('Hello, world!'),
    createDoneEvent(),
  ],
};

/** Tool call response: emits one tool call then done. */
export function toolCallScenario(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): StreamScenario {
  return {
    events: [
      createStartEvent(),
      createToolCallStart(id, name),
      createToolCallEnd(id, name, args),
      createDoneEvent(),
    ],
  };
}

/** Never-ending stream — for testing abort/steer during streaming (pi pattern). */
export const endlessScenario: StreamScenario = {
  events: [createStartEvent(), createTextDelta('streaming...')],
  endless: true,
};
