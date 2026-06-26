import { computed, onMounted, onUnmounted } from 'vue';
import { bridge } from '../api/bridge';
import { useAgentStore } from '../stores/agent';
import { useChatStore } from '../stores/chat';
import { useSessionsStore } from '../stores/sessions';

/**
 * Composable for agent interaction.
 * Sets up IPC listeners and provides send/abort functions.
 */
export function useAgent() {
  const chatStore = useChatStore();
  const agentStore = useAgentStore();
  const sessionsStore = useSessionsStore();

  const cleanups: Array<() => void> = [];
  let nextPromptTimer: ReturnType<typeof setTimeout> | null = null;

  const isBusy = computed(
    () =>
      chatStore.isStreaming ||
      agentStore.status.state === 'thinking' ||
      agentStore.status.state === 'executing',
  );

  function dispatch(text: string): void {
    chatStore.addUserMessage(text);
    chatStore.setActiveSessionId(sessionsStore.activeSessionId ?? '');
    chatStore.startAssistantMessage();
    void bridge
      .saveMessage({
        role: 'user',
        content: [{ type: 'text', text }],
      })
      .then(() => sessionsStore.refresh());
    bridge.prompt(text);
  }

  function scheduleLatestPrompt(): void {
    if (nextPromptTimer) clearTimeout(nextPromptTimer);
    nextPromptTimer = setTimeout(() => {
      nextPromptTimer = null;
      const prompt = agentStore.takeLatestPrompt();
      if (prompt) dispatch(prompt.text);
    }, 120);
  }

  function setupListeners(): void {
    cleanups.push(
      bridge.onStreamEvent((event) => {
        chatStore.handleStreamEvent(event);
      }),
    );

    cleanups.push(
      bridge.onStatusChange((status) => {
        agentStore.setStatus(status);
      }),
    );

    cleanups.push(
      bridge.onError((message) => {
        agentStore.setError(message);
        chatStore.handleStreamEvent({ type: 'error', error: message });
        scheduleLatestPrompt();
      }),
    );

    cleanups.push(
      bridge.onToolStart((toolCall) => {
        chatStore.startToolExecution(toolCall);
        agentStore.startToolExecution(toolCall.id, toolCall.name);
      }),
    );

    cleanups.push(
      bridge.onToolEnd((result) => {
        chatStore.endToolExecution(result);
        agentStore.endToolExecution(result);
      }),
    );

    cleanups.push(
      bridge.onSubagentProgress((executionId, agent, delta) => {
        chatStore.handleSubagentProgress(
          executionId,
          agent,
          delta as unknown as import('@shared/types').SubagentProgressDelta,
        );
      }),
    );

    cleanups.push(
      bridge.onDone((message) => {
        chatStore.handleStreamEvent({ type: 'done', message });
        void sessionsStore.refresh();
        agentStore.setStatus({
          state: 'done',
          turnCount: agentStore.status.turnCount,
          tokenUsage: agentStore.status.tokenUsage,
          modelName: agentStore.status.modelName,
        });
        scheduleLatestPrompt();
      }),
    );

    cleanups.push(
      bridge.onGoalEvent((event) => {
        console.log('[useAgent] Goal event:', event.type, event);
        if (event.type === 'goal_started') {
          agentStore.setGoalActive(true);
        } else if (
          event.type === 'goal_completed' ||
          event.type === 'goal_budget_exhausted' ||
          event.type === 'goal_blocked' ||
          event.type === 'goal_aborted'
        ) {
          agentStore.setGoalActive(false);
        }
      }),
    );
  }

  function send(text: string): void {
    if (!text.trim()) return;

    if (isBusy.value) {
      agentStore.enqueuePrompt(text.trim());
      return;
    }

    dispatch(text.trim());
  }

  function abort(): void {
    bridge.abort();
    chatStore.finishCurrentResponse();
    agentStore.setStatus({
      state: 'idle',
      turnCount: agentStore.status.turnCount,
      tokenUsage: agentStore.status.tokenUsage,
      modelName: agentStore.status.modelName,
    });
  }

  function interruptAndSend(id: string): void {
    const prompt = agentStore.takePrompt(id);
    if (!prompt) return;
    if (nextPromptTimer) {
      clearTimeout(nextPromptTimer);
      nextPromptTimer = null;
    }
    bridge.abort();
    chatStore.finishCurrentResponse();
    agentStore.setStatus({
      state: 'idle',
      turnCount: agentStore.status.turnCount,
      tokenUsage: agentStore.status.tokenUsage,
      modelName: agentStore.status.modelName,
    });
    setTimeout(() => dispatch(prompt.text), 40);
  }

  function continueAgent(): void {
    chatStore.setActiveSessionId(sessionsStore.activeSessionId ?? '');
    chatStore.startAssistantMessage();
    bridge.continue();
  }

  onMounted(() => {
    setupListeners();
  });

  onUnmounted(() => {
    if (nextPromptTimer) clearTimeout(nextPromptTimer);
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  return {
    send,
    abort,
    interruptAndSend,
    continue: continueAgent,
    isStreaming: isBusy,
  };
}
