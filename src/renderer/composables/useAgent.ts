import { computed, onMounted, onUnmounted } from 'vue';
import { bridge } from '../api/bridge';
import { useAgentStore } from '../stores/agent';
import { useChatStore } from '../stores/chat';
import { useSessionsStore } from '../stores/sessions';
import { detectUiLanguage } from '../utils/ui-language';

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

  const isBusy = computed(() => chatStore.isStreaming);

  function dispatch(text: string): void {
    const uiLanguage = detectUiLanguage(text);
    chatStore.addUserMessage(text);
    chatStore.setActiveSessionId(sessionsStore.activeSessionId ?? '');
    chatStore.startAssistantMessage();
    void bridge
      .saveMessage({
        role: 'user',
        content: [{ type: 'text', text }],
        uiLanguage,
      })
      .then(() => sessionsStore.refresh());
    bridge.prompt(text, uiLanguage);
  }

  function scheduleNextPrompt(): void {
    if (nextPromptTimer) clearTimeout(nextPromptTimer);
    nextPromptTimer = setTimeout(() => {
      nextPromptTimer = null;
      const prompt = agentStore.takeFirstPrompt();
      if (prompt) dispatch(prompt.text);
    }, 120);
  }

  function setupListeners(): void {
    cleanups.push(
      bridge.onStreamEvent((data) => {
        chatStore.handleStreamEvent(data.event, data.sessionId);
      }),
    );

    cleanups.push(
      bridge.onStatusChange((data) => {
        // Always store per-session, but only update global status for active session
        if (data.sessionId === sessionsStore.activeSessionId) {
          agentStore.setStatus(data.status);
        }
        agentStore.setStatus(data.status, data.sessionId);
      }),
    );

    cleanups.push(
      bridge.onError((data) => {
        agentStore.setError(data.message);
        chatStore.handleStreamEvent({ type: 'error', error: data.message }, data.sessionId);
        scheduleNextPrompt();
      }),
    );

    cleanups.push(
      bridge.onToolStart((data) => {
        chatStore.startToolExecution(data.toolCall, data.sessionId);
        agentStore.startToolExecution(data.toolCall.id, data.toolCall.name);
      }),
    );

    cleanups.push(
      bridge.onToolEnd((data) => {
        chatStore.endToolExecution(data.toolResult, data.sessionId);
        agentStore.endToolExecution(data.toolResult);
      }),
    );

    cleanups.push(
      bridge.onToolProgress((data) => {
        chatStore.updateToolProgress(data.toolCallId, data.output, data.sessionId);
      }),
    );

    cleanups.push(
      bridge.onRunEvent((data) => {
        chatStore.handleRunEvent(data.event, data.sessionId);
      }),
    );

    cleanups.push(
      bridge.onSubagentProgress((data) => {
        chatStore.handleSubagentProgress(
          data.executionId,
          data.agent,
          data.delta as unknown as import('@shared/types').SubagentProgressDelta,
          data.sessionId,
        );
      }),
    );

    cleanups.push(
      bridge.onDone((data) => {
        chatStore.handleStreamEvent({ type: 'message_end', message: data.message }, data.sessionId);
        void sessionsStore.refresh();
        agentStore.setStatus({
          state: 'done',
          turnCount: agentStore.status.turnCount,
          tokenUsage: agentStore.status.tokenUsage,
          modelName: agentStore.status.modelName,
        });
        scheduleNextPrompt();
      }),
    );

    cleanups.push(
      bridge.onGoalEvent((data) => {
        console.log('[useAgent] Goal event:', data.event.type, data.event);
        if (data.event.type === 'goal_started') {
          agentStore.setGoalActive(true);
        } else if (
          data.event.type === 'goal_completed' ||
          data.event.type === 'goal_budget_exhausted' ||
          data.event.type === 'goal_blocked' ||
          data.event.type === 'goal_aborted'
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

  function stop(): void {
    bridge.stop();
    chatStore.finishCurrentResponse();
    // Don't set idle — agent will resume for the summary turn
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
    stop,
    interruptAndSend,
    continue: continueAgent,
    isStreaming: isBusy,
  };
}
