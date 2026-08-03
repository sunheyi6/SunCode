import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AppSettings, StreamEvent } from '@shared/types';
import { describe, expect, test, vi } from 'vitest';
import { handleStream, isStreamUpdateDue } from '../src/worker/agent/stream-handler';
import type { DiagLogger } from '../src/worker/utils/diag-logger';

describe('stream update coalescing', () => {
  test('emits the first snapshot and limits later snapshots to 20 fps', () => {
    expect(isStreamUpdateDue(undefined, 1_000)).toBe(true);
    expect(isStreamUpdateDue(1_000, 1_049)).toBe(false);
    expect(isStreamUpdateDue(1_000, 1_050)).toBe(true);
  });

  test('flushes the latest cumulative snapshot when a fast stream completes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const received: StreamEvent[] = [];
    const events = [
      { type: 'text_delta', delta: 'a' },
      { type: 'text_delta', delta: 'b' },
      { type: 'text_delta', delta: 'c' },
      { type: 'done', message: { stopReason: 'stop' } },
    ] as unknown as AssistantMessageEvent[];

    async function* stream(): AsyncIterable<AssistantMessageEvent> {
      yield* events;
    }

    await handleStream({
      stream: stream(),
      onStream: (event) => received.push(event),
      onRunEvent: () => {},
      diag: { exit: () => {}, log: () => {} } as unknown as DiagLogger,
      settings: {
        activeProvider: 'test-provider',
        activeModel: 'test-model',
      } as AppSettings,
      systemPrompt: '',
      runId: 'run-test',
      turnCount: 1,
      requestAttempt: 1,
      requestStartTime: 1_000,
      requestMsgSummaries: [],
    });

    const updates = received.filter((event) => event.type === 'message_update');
    expect(updates).toHaveLength(2);
    expect(updates.at(-1)?.data?.text).toBe('abc');
    vi.restoreAllMocks();
  });
});
