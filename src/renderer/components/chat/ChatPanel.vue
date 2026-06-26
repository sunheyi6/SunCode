<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useAgent } from '../../composables/useAgent';
import { useChatStore } from '../../stores/chat';
import { useSettingsStore } from '../../stores/settings';
import ChatHeader from './ChatHeader.vue';
import MessageList from './MessageList.vue';
import ChatInput from './ChatInput.vue';
import PendingPromptQueue from './PendingPromptQueue.vue';

const { send, abort, interruptAndSend, isStreaming } = useAgent();
const chatStore = useChatStore();
const settingsStore = useSettingsStore();

const hasMessages = computed(() => chatStore.messages.length > 0);

const chatZoom = computed(() => settingsStore.settings.fontSize / 14);

function handleSend(text: string): void {
  send(text);
}

function handleStop(): void {
  abort();
}

// ESC to abort
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isStreaming.value) {
    abort();
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="chat-panel" :style="{ zoom: chatZoom }">
    <!-- Header -->
    <ChatHeader />

    <!-- Messages (with welcome when empty) -->
    <template v-if="hasMessages">
      <MessageList />
      <PendingPromptQueue @send-now="interruptAndSend" />
      <div class="input-area">
        <ChatInput @send="handleSend" @stop="handleStop" :is-streaming="isStreaming" />
      </div>
    </template>

    <!-- Empty state: centered welcome + input -->
    <template v-else>
      <div class="welcome-empty">
        <div class="welcome-content">
          <div class="welcome-logo" aria-hidden="true">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
              <circle cx="24" cy="24" r="8" stroke="currentColor" stroke-width="1.5" />
              <path d="M24 2v6M24 40v6M2 24h6M40 24h6M10.3 10.3l4.2 4.2M33.5 33.5l4.2 4.2M10.3 37.7l4.2-4.2M33.5 14.5l4.2-4.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </div>
          <h2>SunCode</h2>
          <p>AI 编程助手</p>
        </div>
        <div class="welcome-input-area">
          <PendingPromptQueue @send-now="interruptAndSend" />
          <ChatInput @send="handleSend" @stop="handleStop" :is-streaming="isStreaming" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.input-area {
  flex-shrink: 0;
}

/* Empty state: vertically centered */
.welcome-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl);
  overflow-y: auto;
}

.welcome-content {
  text-align: center;
  max-width: 480px;
  margin-bottom: 24px;
}

.welcome-logo {
  color: var(--color-text-muted);
  margin-bottom: 8px;
}

.welcome-content h2 {
  font-size: 20px;
  font-weight: 500;
  color: var(--color-text);
  margin: 0 0 4px;
  letter-spacing: 0.02em;
}

.welcome-content > p {
  font-size: 13px;
  color: var(--color-text-muted);
  margin: 0;
}

.welcome-input-area {
  width: 100%;
  max-width: 640px;
}
</style>
