<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useAgent } from '../../composables/useAgent';
import { useBackgroundProcesses } from '../../composables/useBackgroundProcesses';
import { useToast } from '../../composables/useToast';
import { useChatStore } from '../../stores/chat';
import { useSettingsStore } from '../../stores/settings';
import ChatHeader from './ChatHeader.vue';
import ChatInput from './ChatInput.vue';
import { getFantasyWelcomeMessage } from './chat-panel';
import MessageList from './MessageList.vue';
import PendingPromptQueue from './PendingPromptQueue.vue';

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const { send, abort, interruptAndSend, isStreaming } = useAgent();
const chatStore = useChatStore();
const settingsStore = useSettingsStore();
const { killAll: killAllBgProcesses } = useBackgroundProcesses();
const { showToast } = useToast();

const hasMessages = computed(() => chatStore.messages.length > 0);
const welcomeMessage = computed(() => getFantasyWelcomeMessage());

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
    <ChatHeader v-if="hasMessages" />

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
        <div class="welcome-mark" aria-hidden="true">
          <svg viewBox="0 0 360 260" fill="none">
            <path
              d="M102 28H218L190 64H72L102 28Z"
              stroke="currentColor"
              stroke-width="1.4"
            />
            <path
              d="M190 64C173 82 147 90 112 90H72"
              stroke="currentColor"
              stroke-width="1.4"
            />
            <path
              d="M252 28H338L162 232H76L252 28Z"
              stroke="currentColor"
              stroke-width="1.4"
            />
          </svg>
        </div>
        <div class="welcome-content">
          <h2>{{ welcomeMessage }}</h2>
          <PendingPromptQueue @send-now="interruptAndSend" />
          <ChatInput
            @send="handleSend"
            @stop="handleStop"
            :is-streaming="isStreaming"
            :is-empty-conversation="true"
          />
        </div>
      </div>
    </template>

    <!-- Input always at the bottom -->
    <div v-if="hasMessages" class="input-area">
      <ChatInput
        @send="handleSend"
        @stop="handleStop"
        :is-streaming="isStreaming"
      />
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
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 260px;
  padding: 44px var(--spacing-xl);
  overflow-y: auto;
  background: var(--color-bg);
  /* Drag region for frameless window — ChatHeader is hidden on welcome screen */
  -webkit-app-region: drag;
  app-region: drag;
}

.welcome-empty :deep(button),
.welcome-empty :deep(input),
.welcome-empty :deep(textarea) {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.welcome-mark {
  position: absolute;
  top: clamp(28px, 8vh, 78px);
  left: 50%;
  width: min(480px, 58vw);
  color: color-mix(in srgb, var(--color-text-muted) 24%, transparent);
  transform: translateX(-50%);
  pointer-events: none;
}

.welcome-mark svg {
  display: block;
  width: 100%;
  height: auto;
}

.welcome-content {
  position: relative;
  z-index: 1;
  width: 100%;
  text-align: center;
  margin-top: min(120px, 14vh);
}

.welcome-content h2 {
  font-size: 32px;
  font-weight: 400;
  color: var(--color-text);
  margin: 0 0 34px;
  letter-spacing: 0;
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
  border-radius: 8px;
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
