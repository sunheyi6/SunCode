import type { Message, SessionMeta } from '@shared/types';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { bridge } from '../api/bridge';
import { useChatStore } from './chat';

export const useSessionsStore = defineStore('sessions', () => {
  const sessions = ref<SessionMeta[]>([]);
  const activeSessionId = ref<string | null>(null);
  const isLoaded = ref(false);
  /** Cache: pre-warmed session messages (keyed by session id). */
  const sessionMessagesCache = new Map<string, Message[]>();

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

  async function selectSession(id: string, maxMessages?: number): Promise<void> {
    if (id === activeSessionId.value) return;
    console.log(`[Sessions] selectSession id=${id.slice(-8)}`);
    // Prewarmed cache: use 10-msg snapshot for instant display, then reload full.
    const cached = sessionMessagesCache.get(id);
    if (cached && maxMessages === undefined) {
      sessionMessagesCache.delete(id);
      activeSessionId.value = id;
      useChatStore().loadMessages(id, cached);
      // Reload full history in background
      bridge.loadSession(id).then((fullMessages) => {
        if (activeSessionId.value === id) {
          console.log(`[Sessions] selectSession reloaded full: ${fullMessages.length} messages`);
          useChatStore().loadMessages(id, fullMessages);
        }
      });
      return;
    }
    const messages = await bridge.loadSession(id, maxMessages);
    console.log(`[Sessions] selectSession loaded ${messages.length} messages`);
    activeSessionId.value = id;
    useChatStore().loadMessages(id, messages);
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
      prewarmRemaining(10);
    }
    isLoaded.value = true;
  }

  /** Load 10-message snapshots for all remaining sessions in background. */
  function prewarmRemaining(maxMessages: number): void {
    const remaining = sortedSessions.value.slice(1);
    for (const session of remaining) {
      bridge
        .loadSession(session.id, maxMessages)
        .then((messages) => {
          sessionMessagesCache.set(session.id, messages);
          console.log(
            `[Sessions] Prewarmed session id=${session.id.slice(-8)} msgs=${messages.length}`,
          );
        })
        .catch(() => {
          // Skip unreadable sessions
        });
    }
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
  };
});
