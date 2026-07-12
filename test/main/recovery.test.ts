import type { Message, SessionMeta } from '@shared/types';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendEvent: vi.fn(),
  findStaleRuns: vi.fn(),
  getEvents: vi.fn(),
  listRuns: vi.fn(),
  loadAllSessions: vi.fn(),
  loadSession: vi.fn(),
  saveSession: vi.fn(),
}));

vi.mock('../../src/main/run-store', () => ({
  appendEvent: mocks.appendEvent,
  findStaleRuns: mocks.findStaleRuns,
  getEvents: mocks.getEvents,
  listRuns: mocks.listRuns,
}));

vi.mock('../../src/main/session-store', () => ({
  loadAllSessions: mocks.loadAllSessions,
  loadSession: mocks.loadSession,
  saveSession: mocks.saveSession,
}));

const { recoverInterruptedSessions } = await import('../../src/main/recovery');

function session(id: string, updated: string): SessionMeta {
  return {
    id,
    name: id,
    created: updated,
    updated,
    messageCount: 1,
    workingDirectory: `D:\\workspace\\${id}`,
  };
}

describe('recoverInterruptedSessions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.appendEvent.mockReset();
    mocks.findStaleRuns.mockReset();
    mocks.getEvents.mockReset();
    mocks.listRuns.mockReset();
    mocks.loadAllSessions.mockReset();
    mocks.loadSession.mockReset();
    mocks.saveSession.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('repairs only recent sessions before deferring older sessions', async () => {
    const sessions = Array.from({ length: 7 }, (_, index) =>
      session(`session-${index}`, `2026-07-02T10:0${index}:00.000Z`),
    );
    const messages: Message[] = [{ role: 'user', content: 'continue' }];

    mocks.loadAllSessions.mockResolvedValue(sessions);
    mocks.findStaleRuns.mockResolvedValue([]);
    mocks.listRuns.mockResolvedValue([]);
    mocks.loadSession.mockResolvedValue({ meta: sessions[0], messages });

    await recoverInterruptedSessions({
      initialLimit: 2,
      backgroundBatchSize: 2,
      backgroundInitialDelayMs: 100,
      backgroundBatchDelayMs: 50,
    });

    expect(mocks.findStaleRuns.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'session-0',
      'session-1',
    ]);

    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.findStaleRuns.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'session-0',
      'session-1',
      'session-2',
      'session-3',
    ]);

    await vi.advanceTimersByTimeAsync(50);

    expect(mocks.findStaleRuns.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'session-0',
      'session-1',
      'session-2',
      'session-3',
      'session-4',
      'session-5',
    ]);
  });

  test('can skip background scheduling for deterministic startup repair', async () => {
    const sessions = [session('recent', '2026-07-02T10:00:00.000Z')];
    const messages: Message[] = [{ role: 'user', content: 'continue' }];

    mocks.loadAllSessions.mockResolvedValue(sessions);
    mocks.findStaleRuns.mockResolvedValue(['run-1']);
    mocks.listRuns.mockResolvedValue([]);
    mocks.loadSession.mockResolvedValue({ meta: sessions[0], messages });

    await recoverInterruptedSessions({ scheduleBackground: false });

    expect(mocks.appendEvent).toHaveBeenCalledWith('recent', 'run-1', expect.objectContaining({
      reason: 'app_restarted',
      type: 'run_recovered',
    }));
    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'recent', messageCount: 2 }),
      expect.arrayContaining([expect.objectContaining({ role: 'assistant' })]),
    );
  });

  test('rebuilds a missing assistant message from a completed run', async () => {
    const sessions = [session('recent', '2026-07-02T10:00:00.000Z')];
    const messages: Message[] = [
      { role: 'assistant', content: 'previous answer' },
      { role: 'user', content: 'continue' },
    ];
    const responseText = JSON.stringify({
      type: 'suncode.message',
      role: 'assistant',
      content: { text: 'Recovered answer' },
    });

    mocks.loadAllSessions.mockResolvedValue(sessions);
    mocks.findStaleRuns.mockResolvedValue([]);
    mocks.listRuns.mockResolvedValue(['run-1']);
    mocks.getEvents.mockResolvedValue([
      {
        type: 'model_request_completed',
        runId: 'run-1',
        turnNumber: 1,
        attempt: 1,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        durationMs: 100,
        timestamp: '2026-07-02T10:00:01.000Z',
        stopReason: 'stop',
        responseText,
      },
      {
        type: 'run_completed',
        runId: 'run-1',
        turnCount: 1,
        timestamp: '2026-07-02T10:00:01.000Z',
      },
    ]);
    mocks.loadSession.mockResolvedValue({ meta: sessions[0], messages });

    await recoverInterruptedSessions({ scheduleBackground: false });

    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'recent', messageCount: 3 }),
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: [{ type: 'text', text: 'Recovered answer' }],
        }),
      ]),
    );
  });
});
