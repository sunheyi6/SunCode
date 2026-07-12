import type { Message, SessionMeta } from '@shared/types';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { bridge } from '../api/bridge';
import { useChatStore } from './chat';

export const useSessionsStore = defineStore('sessions', () => {
  const SESSION_SNAPSHOT_SIZE = 10;
  const PREWARM_CONCURRENCY = 4;
  const sessions = ref<SessionMeta[]>([]);
  const activeSessionId = ref<string | null>(null);
  const isLoaded = ref(false);
  /** Cache: bounded snapshots used for the first paint of a session. */
  const sessionMessagesCache = new Map<string, Message[]>();
  /** Cache: full histories used only for background hydration and Worker continuity. */
  const fullSessionMessagesCache = new Map<string, Message[]>();
  const fullLoadPromises = new Map<string, Promise<Message[]>>();
  const cacheGenerations = new Map<string, number>();
  let selectionRequestId = 0;

  const sortedSessions = computed(() =>
    [...sessions.value].sort(
      (a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime(),
    ),
  );

  async function refresh(): Promise<void> {
    sessions.value = await bridge.getSessions();
  }

  async function createSession(workingDirectory?: string): Promise<void> {
    const now = new Date();
    const name = `新对话 ${now.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
    const session = await bridge.createSession(name, workingDirectory);
    sessions.value.unshift(session);
    activeSessionId.value = session.id;
    useChatStore().loadMessages(session.id, []);
  }

  async function selectSession(id: string, maxMessages?: number, force = false): Promise<void> {
    if (!force && id === activeSessionId.value) return;
    console.log(`[Sessions] selectSession id=${id.slice(-8)}`);
    const requestId = ++selectionRequestId;
    const snapshotSize = maxMessages ?? SESSION_SNAPSHOT_SIZE;
    const cached = sessionMessagesCache.get(id);
    const fullCached = fullSessionMessagesCache.get(id);
    const messages =
      (cached ? tailMessages(cached, snapshotSize) : undefined) ??
      (fullCached
        ? tailMessages(fullCached, snapshotSize)
        : await bridge.loadSession(id, snapshotSize));
    if (requestId !== selectionRequestId) return;

    console.log(`[Sessions] selectSession loaded snapshot ${messages.length} messages`);
    activeSessionId.value = id;
    useChatStore().loadMessages(id, messages);
    void hydrateFullSession(id, requestId);
  }

  function hydrateFullSession(id: string, requestId: number): Promise<void> {
    const generation = cacheGenerations.get(id) ?? 0;
    let fullLoad = fullSessionMessagesCache.has(id)
      ? Promise.resolve(fullSessionMessagesCache.get(id) as Message[])
      : fullLoadPromises.get(id);
    if (!fullLoad) {
      fullLoad = bridge.loadSession(id);
      fullLoadPromises.set(id, fullLoad);
      void fullLoad.then(
        () => {
          if (fullLoadPromises.get(id) === fullLoad) fullLoadPromises.delete(id);
        },
        () => {
          if (fullLoadPromises.get(id) === fullLoad) fullLoadPromises.delete(id);
        },
      );
    }

    return fullLoad
      .then((messages) => {
        if ((cacheGenerations.get(id) ?? 0) !== generation) return;
        fullSessionMessagesCache.set(id, messages);
        sessionMessagesCache.set(id, tailMessages(messages, SESSION_SNAPSHOT_SIZE));
        if (requestId === selectionRequestId && activeSessionId.value === id) {
          console.log(`[Sessions] selectSession hydrated full: ${messages.length} messages`);
          useChatStore().loadMessages(id, messages);
        }
      })
      .catch(() => {
        // Keep the snapshot visible when full history cannot be loaded.
      });
  }

  /** Drop histories that may predate a message persisted by an active run. */
  function invalidateSessionCache(id: string): void {
    sessionMessagesCache.delete(id);
    fullSessionMessagesCache.delete(id);
    fullLoadPromises.delete(id);
    cacheGenerations.set(id, (cacheGenerations.get(id) ?? 0) + 1);
  }

  async function init(): Promise<void> {
    if (isLoaded.value) return;
    await refresh();
    if (sessions.value.length === 0) {
      await createSession();
    } else {
      // On startup, only load last 10 messages of the most recent session for quick display.
      await selectSession(sortedSessions.value[0].id, 10);
      // Pre-warm all remaining sessions in background (no await).
      prewarmRemaining(SESSION_SNAPSHOT_SIZE);
    }
    isLoaded.value = true;
  }

  /** Load message snapshots for all remaining sessions in background. */
  function prewarmRemaining(maxMessages: number): void {
    const remaining = sortedSessions.value.slice(1);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < remaining.length) {
        const session = remaining[nextIndex];
        nextIndex += 1;
        try {
          const messages = await bridge.loadSession(session.id, maxMessages);
          sessionMessagesCache.set(session.id, messages);
          console.log(
            `[Sessions] Prewarmed session id=${session.id.slice(-8)} msgs=${messages.length}`,
          );
        } catch {
          // Skip unreadable sessions
        }
      }
    };

    void Promise.all(
      Array.from({ length: Math.min(PREWARM_CONCURRENCY, remaining.length) }, () => worker()),
    );
  }

  function tailMessages(messages: Message[], maxMessages: number): Message[] {
    if (maxMessages <= 0) return [];
    return messages.length <= maxMessages ? messages : messages.slice(-maxMessages);
  }

  async function deleteSession(id: string): Promise<void> {
    const result = await bridge.deleteSession(id);
    sessions.value = result.remaining;
    if (result.wasActive) {
      if (sessions.value.length > 0) {
        await selectSession(sortedSessions.value[0].id);
      } else {
        activeSessionId.value = null;
        useChatStore().setActiveSessionId(null);
        useChatStore().clearMessages();
      }
    }
  }

  async function deleteSessions(ids: string[]): Promise<void> {
    const result = await bridge.deleteSessions(ids);
    sessions.value = result.remaining;
    if (result.wasActive) {
      if (sessions.value.length > 0) {
        await selectSession(sortedSessions.value[0].id);
      } else {
        activeSessionId.value = null;
        useChatStore().setActiveSessionId(null);
        useChatStore().clearMessages();
      }
    }
  }

  return {
    sessions,
    sortedSessions,
    activeSessionId,
    isLoaded,
    init,
    refresh,
    createSession,
    selectSession,
    deleteSession,
    deleteSessions,
    invalidateSessionCache,
  };
});
