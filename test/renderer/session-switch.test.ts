import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Message, SessionMeta } from '../../src/shared/types';
import { useChatStore } from '../../src/renderer/stores/chat';

const { loadSessionMock, loadSessionSnapshotMock, getSessionsMock } = vi.hoisted(() => ({
  loadSessionMock: vi.fn(),
  loadSessionSnapshotMock: vi.fn(),
  getSessionsMock: vi.fn(),
}));

vi.mock('../../src/renderer/api/bridge', () => ({
  bridge: {
    getSessions: getSessionsMock,
    loadSession: loadSessionMock,
    loadSessionSnapshot: loadSessionSnapshotMock,
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteSessions: vi.fn(),
  },
}));

import { useSessionsStore } from '../../src/renderer/stores/sessions';

function session(id: string): SessionMeta {
  return {
    id,
    name: id,
    created: '2026-07-10T12:00:00.000Z',
    updated: '2026-07-10T12:00:00.000Z',
    messageCount: 12,
    workingDirectory: 'D:\\project\\SunCode',
  };
}

function messages(prefix: string, count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    role: 'user' as const,
    content: [{ type: 'text' as const, text: `${prefix}-${index}` }],
  }));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('session switching', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    loadSessionMock.mockReset();
    loadSessionSnapshotMock.mockReset();
    getSessionsMock.mockReset();
  });

  test('renders a ten-message snapshot before full history hydration finishes', async () => {
    const full = deferred<Message[]>();
    const recent = messages('recent', 10);
    loadSessionSnapshotMock.mockResolvedValue(recent);
    loadSessionMock.mockReturnValue(full.promise);

    const store = useSessionsStore();
    store.sessions = [session('session-1')];
    const selection = store.selectSession('session-1');

    await vi.waitFor(() => expect(store.activeSessionId).toBe('session-1'));
    const { useChatStore } = await import('../../src/renderer/stores/chat');
    expect(useChatStore().messages).toHaveLength(10);
    expect(loadSessionSnapshotMock).toHaveBeenCalledWith('session-1', 10);

    full.resolve(messages('full', 20));
    await selection;
    await vi.waitFor(() => expect(useChatStore().messages).toHaveLength(20));
    expect(loadSessionMock).toHaveBeenCalledWith('session-1');
  });

  test('does not let an older hydration request replace the newer session', async () => {
    const oldFull = deferred<Message[]>();
    const newFull = deferred<Message[]>();
    loadSessionSnapshotMock.mockImplementation((id: string) =>
      Promise.resolve(messages(`${id}-recent`, 10)),
    );
    loadSessionMock.mockImplementation((id: string) =>
      id === 'old' ? oldFull.promise : newFull.promise,
    );

    const store = useSessionsStore();
    store.sessions = [session('old'), session('new')];
    await store.selectSession('old');
    await store.selectSession('new');

    oldFull.resolve(messages('old-full', 20));
    newFull.resolve(messages('new-full', 20));

    const { useChatStore } = await import('../../src/renderer/stores/chat');
    await vi.waitFor(() => expect(useChatStore().messages[0]?.content).toContain('new-full'));
    expect(useChatStore().messages[0]?.content).not.toContain('old-full');
  });

  test('uses the full-history cache without requesting it again', async () => {
    const full = messages('full', 20);
    loadSessionSnapshotMock.mockResolvedValue(full.slice(-10));
    loadSessionMock.mockResolvedValue(full);

    const store = useSessionsStore();
    store.sessions = [session('session-1')];
    await store.selectSession('session-1');
    await vi.waitFor(() => expect(useChatStore().messages).toHaveLength(20));

    await store.selectSession('session-2');
    await store.selectSession('session-1');
    await vi.waitFor(() => expect(useChatStore().messages).toHaveLength(20));

    expect(loadSessionSnapshotMock).toHaveBeenCalledTimes(2);
    expect(loadSessionMock).toHaveBeenCalledTimes(2);
  });

  test('reloads a session after an active run invalidates its cached history', async () => {
    let persisted = false;
    loadSessionSnapshotMock.mockImplementation((id: string) => {
      const prefix = persisted ? 'fresh' : 'stale';
      const history = messages(`${id}-${prefix}`, 12);
      return Promise.resolve(history.slice(-10));
    });
    loadSessionMock.mockImplementation((id: string) => {
      const prefix = persisted ? 'fresh' : 'stale';
      return Promise.resolve(messages(`${id}-${prefix}`, 12));
    });

    const store = useSessionsStore();
    store.sessions = [session('old'), session('new')];
    await store.selectSession('old');
    await vi.waitFor(() => expect(useChatStore().messages[0]?.content).toContain('stale'));

    store.invalidateSessionCache('old');
    persisted = true;
    await store.selectSession('new');
    await store.selectSession('old');

    await vi.waitFor(() => expect(useChatStore().messages[0]?.content).toContain('fresh'));
  });
});
