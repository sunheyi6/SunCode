import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AppSettings, RunEvent, StreamEvent } from '@shared/types';
import { describe, expect, test, vi } from 'vitest';
import { handleStream, isStreamUpdateDue } from '../src/worker/agent/stream-handler';
import { captureProviderResponse } from '../src/worker/agent/model-request-observability';
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
      diag: { exit: () => {}, log: () => {}, milestone: () => {} } as unknown as DiagLogger,
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

  test('records response headers, first stream event, first token, and response id separately', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValue(1_500)
      .mockReturnValueOnce(1_300)
      .mockReturnValueOnce(1_400);
    const runEvents: RunEvent[] = [];
    const events = [
      { type: 'start', partial: {} },
      { type: 'text_delta', delta: 'a', partial: {} },
      {
        type: 'done',
        message: { responseId: 'response-123', stopReason: 'stop', usage: {} },
      },
    ] as unknown as AssistantMessageEvent[];

    async function* stream(): AsyncIterable<AssistantMessageEvent> {
      yield* events;
    }

    await handleStream({
      stream: stream(),
      onStream: () => {},
      onRunEvent: (event) => runEvents.push(event),
      diag: { exit: () => {}, log: () => {}, milestone: () => {} } as unknown as DiagLogger,
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
      getProviderResponseTelemetry: () => ({
        status: 200,
        headersLatencyMs: 250,
        requestId: 'request-123',
        serverTiming: 'edge;dur=12',
        upstreamServiceTimeMs: 11,
      }),
      emitToStream: false,
    });

    expect(runEvents).toHaveLength(1);
    expect(runEvents[0]).toMatchObject({
      type: 'model_request_completed',
      durationMs: 500,
      responseHeadersLatencyMs: 250,
      firstStreamEventLatencyMs: 300,
      firstTokenLatencyMs: 400,
      providerStatus: 200,
      providerRequestId: 'request-123',
      responseId: 'response-123',
      serverTiming: 'edge;dur=12',
      upstreamServiceTimeMs: 11,
    });
    vi.restoreAllMocks();
  });

  test('keeps only safe provider response diagnostics', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_250);
    expect(
      captureProviderResponse(
        {
          status: 200,
          headers: {
            'X-Request-ID': 'request-123',
            'Server-Timing': 'edge;dur=12',
            'X-Envoy-Upstream-Service-Time': '11',
            'Set-Cookie': 'secret=value',
          },
        },
        1_000,
      ),
    ).toEqual({
      status: 200,
      headersLatencyMs: 250,
      requestId: 'request-123',
      serverTiming: 'edge;dur=12',
      upstreamServiceTimeMs: 11,
    });
    vi.restoreAllMocks();
  });
});
