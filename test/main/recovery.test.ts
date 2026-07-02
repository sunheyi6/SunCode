import type { Message, SessionMeta } from '@shared/types';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendEvent: vi.fn(),
  findStaleRuns: vi.fn(),
  loadAllSessions: vi.fn(),
  loadSession: vi.fn(),
  saveSession: vi.fn(),
}));

vi.mock('../../src/main/run-store', () => ({
  appendEvent: mocks.appendEvent,
  findStaleRuns: mocks.findStaleRuns,
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
});
