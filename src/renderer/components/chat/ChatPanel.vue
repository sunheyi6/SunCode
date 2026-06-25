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
          <div class="welcome-icon">☀️</div>
          <h2>欢迎使用 SunCode</h2>
          <p>你的 AI 智能编程助手</p>
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
  max-width: 560px;
  margin-bottom: 32px;
}

.welcome-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.welcome-content h2 {
  font-size: 22px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 6px;
}

.welcome-content > p {
  font-size: 14px;
  color: var(--color-text-secondary);
  margin: 0 0 20px;
}

.welcome-input-area {
  width: 100%;
  max-width: 720px;
}
</style>
