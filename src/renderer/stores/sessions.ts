import type { SessionMeta } from '@shared/types';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { bridge } from '../api/bridge';
import { useChatStore } from './chat';

export const useSessionsStore = defineStore('sessions', () => {
  const sessions = ref<SessionMeta[]>([]);
  const activeSessionId = ref<string | null>(null);
  const isLoaded = ref(false);

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
    useChatStore().clearMessages();
  }

  async function selectSession(id: string): Promise<void> {
    if (id === activeSessionId.value) return;
    const messages = await bridge.loadSession(id);
    activeSessionId.value = id;
    useChatStore().loadMessages(messages);
  }

  async function init(): Promise<void> {
    if (isLoaded.value) return;
    await refresh();
    if (sessions.value.length === 0) {
      await createSession();
    } else {
      await selectSession(sortedSessions.value[0].id);
    }
    isLoaded.value = true;
  }

  async function deleteSession(id: string): Promise<void> {
    const result = await bridge.deleteSession(id);
    sessions.value = result.remaining;
    if (result.wasActive) {
      if (sessions.value.length > 0) {
        await selectSession(sortedSessions.value[0].id);
      } else {
        activeSessionId.value = null;
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
