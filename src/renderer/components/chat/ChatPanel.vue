<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useAgent } from '../../composables/useAgent';
import { useChatStore } from '../../stores/chat';
import ChatHeader from './ChatHeader.vue';
import MessageList from './MessageList.vue';
import ChatInput from './ChatInput.vue';
import PendingPromptQueue from './PendingPromptQueue.vue';

const { send, abort, interruptAndSend, isStreaming } = useAgent();
const chatStore = useChatStore();

const hasMessages = computed(() => chatStore.messages.length > 0);

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
  <div class="chat-panel">
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
          <div class="welcome-hints">
            <p>试试这样问：</p>
            <ul>
              <li>"解释一下这个项目的认证系统是怎么工作的"</li>
              <li>"当前文件夹结构是什么样的"</li>
              <li>"给 UserService 类添加单元测试"</li>
              <li>"重构这个函数，让它更易读"</li>
            </ul>
          </div>
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
  font-size: 15px;
  color: var(--color-text-secondary);
  margin: 0 0 20px;
}

.welcome-hints {
  text-align: left;
  background: var(--color-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  padding: var(--spacing-md) var(--spacing-lg);
}

.welcome-hints p {
  margin: 0 0 6px;
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text);
}

.welcome-hints ul {
  margin: 0;
  padding-left: 18px;
}

.welcome-hints li {
  margin: 3px 0;
  font-size: 13px;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.welcome-input-area {
  width: 100%;
  max-width: 720px;
}
</style>
