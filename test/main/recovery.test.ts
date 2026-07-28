import type { RuntimeEvent, RuntimeEventDraft } from '@shared/runtime-events';
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
  appendRuntimeEvent: vi.fn(),
  initializeRuntimeLedger: vi.fn(),
  readRuntimeEvents: vi.fn(),
  readRuntimePartial: vi.fn(),
  clearRuntimePartial: vi.fn(),
  runtimeEvents: [] as RuntimeEvent[],
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

vi.mock('../../src/main/runtime-event-store', () => ({
  appendRuntimeEvent: mocks.appendRuntimeEvent,
  initializeRuntimeLedger: mocks.initializeRuntimeLedger,
  readRuntimeEvents: mocks.readRuntimeEvents,
  readRuntimePartial: mocks.readRuntimePartial,
  clearRuntimePartial: mocks.clearRuntimePartial,
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
    mocks.getEvents.mockResolvedValue([]);
    mocks.listRuns.mockReset();
    mocks.loadAllSessions.mockReset();
    mocks.loadSession.mockReset();
    mocks.saveSession.mockReset();
    mocks.appendRuntimeEvent.mockReset();
    mocks.initializeRuntimeLedger.mockReset();
    mocks.readRuntimeEvents.mockReset();
    mocks.readRuntimePartial.mockReset();
    mocks.clearRuntimePartial.mockReset();
    mocks.runtimeEvents.length = 0;
    mocks.initializeRuntimeLedger.mockImplementation(
      async (sessionId: string, messages: Message[]) => {
        if (mocks.runtimeEvents.length === 0 && messages.length > 0) {
          mocks.runtimeEvents.push({
            protocolVersion: 1,
            eventId: `${sessionId}:legacy-snapshot`,
            sequence: 1,
            timestamp: '2026-07-02T10:00:00.000Z',
            sessionId,
            partial: false,
            fact: { type: 'legacy_snapshot_imported', messages },
          });
        }
        return [...mocks.runtimeEvents];
      },
    );
    mocks.appendRuntimeEvent.mockImplementation(
      async (sessionId: string, draft: RuntimeEventDraft) => {
        const existing = draft.eventId
          ? mocks.runtimeEvents.find((event) => event.eventId === draft.eventId)
          : undefined;
        if (existing) return existing;
        const previous = mocks.runtimeEvents.at(-1);
        const event: RuntimeEvent = {
          protocolVersion: 1,
          eventId: draft.eventId ?? `event-${mocks.runtimeEvents.length + 1}`,
          sequence: mocks.runtimeEvents.length + 1,
          timestamp: draft.timestamp ?? '2026-07-02T10:00:01.000Z',
          previousEventId: previous?.eventId,
          sessionId,
          turnId: draft.turnId,
          runId: draft.runId,
          invocationId: draft.invocationId,
          partial: false,
          fact: draft.fact,
        };
        mocks.runtimeEvents.push(event);
        return event;
      },
    );
    mocks.readRuntimeEvents.mockImplementation(async () => [...mocks.runtimeEvents]);
    mocks.readRuntimePartial.mockResolvedValue(null);
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

  test('terminates a semantic invocation that crashed before its operational run started', async () => {
    const sessions = [session('recent', '2026-07-02T10:00:00.000Z')];
    const userMessage: Message = { role: 'user', content: 'question' };
    mocks.runtimeEvents.push({
      protocolVersion: 1,
      eventId: 'run-semantic:user',
      sequence: 1,
      timestamp: '2026-07-02T10:00:00.000Z',
      sessionId: 'recent',
      turnId: 'turn-semantic',
      runId: 'run-semantic',
      invocationId: 'run-semantic',
      partial: false,
      fact: { type: 'user_message_committed', source: 'dispatch', message: userMessage },
    });
    mocks.loadAllSessions.mockResolvedValue(sessions);
    mocks.findStaleRuns.mockResolvedValue([]);
    mocks.listRuns.mockResolvedValue([]);
    mocks.loadSession.mockResolvedValue({ meta: sessions[0], messages: [userMessage] });

    await recoverInterruptedSessions({ scheduleBackground: false });

    expect(mocks.runtimeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invocationId: 'run-semantic',
          fact: expect.objectContaining({ type: 'invocation_terminated', status: 'interrupted' }),
        }),
      ]),
    );
    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'recent', messageCount: 2 }),
      expect.arrayContaining([expect.objectContaining({ role: 'assistant' })]),
    );
  });

  test('skips healthy sessions without loading full history or writing', async () => {
    const sessions = [session('healthy', '2026-07-02T10:00:00.000Z')];
    const messages: Message[] = [{ role: 'assistant', content: 'already done' }];

    mocks.loadAllSessions.mockResolvedValue(sessions);
    mocks.findStaleRuns.mockResolvedValue([]);
    mocks.listRuns.mockResolvedValue([]);
    mocks.loadSession.mockResolvedValue({ meta: sessions[0], messages });

    await recoverInterruptedSessions({ scheduleBackground: false });

    expect(mocks.loadSession).toHaveBeenCalledWith('healthy', 1);
    expect(mocks.loadSession).not.toHaveBeenCalledWith('healthy');
    expect(mocks.saveSession).not.toHaveBeenCalled();
    expect(mocks.appendRuntimeEvent).not.toHaveBeenCalled();
  });

  test('repairs multiple open semantic runs independently', async () => {
    const sessions = [session('recent', '2026-07-02T10:00:00.000Z')];
    const firstUser: Message = { role: 'user', content: 'first' };
    const secondUser: Message = { role: 'user', content: 'second' };
    mocks.runtimeEvents.push(
      {
        protocolVersion: 1,
        eventId: 'run-a:user',
        sequence: 1,
        timestamp: '2026-07-02T10:00:00.000Z',
        sessionId: 'recent',
        turnId: 'turn-a',
        runId: 'run-a',
        invocationId: 'run-a',
        partial: false,
        fact: { type: 'user_message_committed', source: 'dispatch', message: firstUser },
      },
      {
        protocolVersion: 1,
        eventId: 'run-b:user',
        sequence: 2,
        timestamp: '2026-07-02T10:00:01.000Z',
        sessionId: 'recent',
        turnId: 'turn-b',
        runId: 'run-b',
        invocationId: 'run-b',
        partial: false,
        fact: { type: 'user_message_committed', source: 'dispatch', message: secondUser },
      },
    );
    mocks.loadAllSessions.mockResolvedValue(sessions);
    mocks.findStaleRuns.mockResolvedValue([]);
    mocks.listRuns.mockResolvedValue([]);
    mocks.loadSession.mockResolvedValue({
      meta: sessions[0],
      messages: [firstUser, secondUser],
    });

    await recoverInterruptedSessions({ scheduleBackground: false });

    const terminals = mocks.runtimeEvents.filter(
      (event) => event.fact.type === 'invocation_terminated',
    );
    expect(terminals.map((event) => event.invocationId).sort()).toEqual(['run-a', 'run-b']);
    const assistants = mocks.runtimeEvents.filter(
      (event) => event.fact.type === 'assistant_message_committed',
    );
    expect(assistants).toHaveLength(2);
    // Recovery assistants are appended after existing user facts, so both
    // interrupted answers land at the tail in repair order.
    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'recent', messageCount: 4 }),
      [
        expect.objectContaining({ role: 'user', content: 'first' }),
        expect.objectContaining({ role: 'user', content: 'second' }),
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({ role: 'assistant' }),
      ],
    );
  });
});
