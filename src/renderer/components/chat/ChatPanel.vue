<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch, ref } from 'vue';
import { useAgent } from '../../composables/useAgent';
import { useChatStore } from '../../stores/chat';
import { useSettingsStore } from '../../stores/settings';
import { useBackgroundProcesses } from '../../composables/useBackgroundProcesses';
import { useToast } from '../../composables/useToast';
import ChatHeader from './ChatHeader.vue';
import MessageList from './MessageList.vue';
import ChatInput from './ChatInput.vue';
import PendingPromptQueue from './PendingPromptQueue.vue';

const { send, abort, interruptAndSend, isStreaming } = useAgent();
const chatStore = useChatStore();
const settingsStore = useSettingsStore();
const { killAll: killAllBgProcesses } = useBackgroundProcesses();
const { showToast } = useToast();

const hasMessages = computed(() => chatStore.messages.length > 0);

const chatZoom = computed(() => settingsStore.settings.fontSize / 14);

// Auto-dismiss model switch notice after 5 seconds
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => chatStore.modelSwitchNotice,
  (text) => {
    if (noticeTimer) clearTimeout(noticeTimer);
    if (text) {
      noticeTimer = setTimeout(() => {
        chatStore.dismissModelSwitchNotice();
        noticeTimer = null;
      }, 5000);
    }
  },
);

function handleSend(text: string): void {
  send(text);
}

function handleStop(): void {
  abort();
  const killed = killAllBgProcesses();
  if (killed > 0) {
    showToast(`已停止 ${killed} 个后台进程`, 'warning');
  }
}

// ESC to abort
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isStreaming.value) {
    abort();
    const killed = killAllBgProcesses();
    if (killed > 0) {
      showToast(`已停止 ${killed} 个后台进程`, 'warning');
    }
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
      <!-- Model switch notice -->
      <div
        v-if="chatStore.modelSwitchNotice"
        class="model-switch-notice"
      >
        <span class="notice-icon">🔄</span>
        <span class="notice-text">{{ chatStore.modelSwitchNotice }}</span>
        <button class="notice-dismiss" @click="chatStore.dismissModelSwitchNotice()">✕</button>
      </div>

      <MessageList />
      <PendingPromptQueue @send-now="interruptAndSend" />
    </template>

    <!-- Empty state: centered welcome content only (input stays at bottom) -->
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
      </div>
    </template>

    <!-- Input always at the bottom -->
    <div class="input-area">
      <PendingPromptQueue v-if="!hasMessages" @send-now="interruptAndSend" />
      <ChatInput @send="handleSend" @stop="handleStop" :is-streaming="isStreaming" />
    </div>
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--color-bg);
}

.input-area {
  flex-shrink: 0;
  padding: 0 18px 14px;
}

/* Empty state: fills flex space, content centered, input stays at bottom */
.welcome-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl) var(--spacing-xl) 12px;
  overflow-y: auto;
}

.welcome-content {
  text-align: center;
  max-width: 480px;
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

/* Model switch notice banner */
.model-switch-notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  margin: 8px 16px 0;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 10%, transparent) 0%, color-mix(in srgb, var(--color-accent) 4%, transparent) 100%);
  border: 1px solid color-mix(in srgb, var(--color-accent) 18%, var(--border-color));
  border-radius: var(--border-radius);
  font-size: 13px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
  animation: noticeSlideIn 0.2s ease;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

@keyframes noticeSlideIn {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.notice-icon {
  font-size: 15px;
  flex-shrink: 0;
  opacity: 0.85;
}

.notice-text {
  flex: 1;
  line-height: 1.4;
}

.notice-dismiss {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.12s;
  flex-shrink: 0;
}

.notice-dismiss:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}
</style>
