<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useChatStore } from '../../stores/chat';
import AssistantMessage from './AssistantMessage.vue';
import UserMessage from './UserMessage.vue';

const chatStore = useChatStore();
const messageListRef = ref<HTMLElement | null>(null);
const userScrolledUp = ref(false);
let scrollTimer: ReturnType<typeof setTimeout> | null = null;

function scrollToBottom(smooth = false): void {
  const el = messageListRef.value;
  if (!el) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (smooth) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    });
  });
}

function isAtBottom(): boolean {
  const el = messageListRef.value;
  if (!el) return false;
  // 20px threshold — must be essentially at the very bottom
  return el.scrollHeight - el.scrollTop - el.clientHeight < 20;
}

/** Composite key — changes less frequently than every character. */
let lastKey = '';
function lastMessageContentKey(): string {
  const last = chatStore.messages[chatStore.messages.length - 1];
  if (!last) return '';
  // Only trigger on ~100 char chunks, not every character
  const thinkLen = Math.floor((last.thinking?.length ?? 0) / 100);
  const contentLen = Math.floor((last.content?.length ?? 0) / 100);
  const blockLen = last.blocks?.length ?? 0;
  const toolOutputLen = Math.floor(
    (last.toolCalls?.reduce((sum, toolCall) => sum + (toolCall.partialOutput?.length ?? 0), 0) ??
      0) / 100,
  );
  const tcLen = last.toolCalls?.length ?? 0;
  const tcRunning = last.toolCalls?.filter((t) => t.status === 'running').length ?? 0;
  return `${thinkLen}|${contentLen}|${blockLen}|${toolOutputLen}|${tcLen}|${tcRunning}`;
}

function onUserScroll(): void {
  userScrolledUp.value = !isAtBottom();
}

// Scroll to bottom when a new message is added (user initiated)
watch(
  () => chatStore.messages.length,
  () => {
    userScrolledUp.value = false;
    void nextTick().then(() => scrollToBottom());
  },
);

// Auto-scroll when the last message content changes, unless user manually scrolled up.
// This covers streaming text, tool execution results, and subagent progress — all of
// which can change content height without changing messages.length.
watch(
  () => lastMessageContentKey(),
  (key) => {
    if (key === lastKey) return;
    lastKey = key;
    if (userScrolledUp.value) return;
    // Throttle: max one scroll per 150ms
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      scrollToBottom();
    }, 150);
  },
);

// When streaming finishes, keep the newest content anchored at the bottom.
watch(
  () => chatStore.isStreaming,
  (streaming) => {
    if (!streaming) {
      userScrolledUp.value = false;
      setTimeout(() => scrollToBottom(true), 100);
    }
  },
);

onMounted(() => {
  messageListRef.value?.addEventListener('scroll', onUserScroll, { passive: true });
});
onUnmounted(() => {
  messageListRef.value?.removeEventListener('scroll', onUserScroll);
});
</script>

<template>
  <div class="message-list" ref="messageListRef">
    <!-- 消息列表 -->
    <template v-for="msg in chatStore.messages" :key="msg.id">
      <UserMessage v-if="msg.role === 'user'" :message="msg" />
      <AssistantMessage v-else-if="msg.role === 'assistant'" :message="msg" />
    </template>

    <!-- 滚动到底部按钮 -->
    <Transition name="scroll-btn">
      <button
        v-if="userScrolledUp"
        class="scroll-to-bottom-btn"
        title="跳转到最新内容"
        @click="scrollToBottom(true)"
      >
        <span class="scroll-btn-icon">↓</span>
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.message-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-md) 0;
  position: relative;
}

/* ---- 滚动到底部按钮 ---- */
.scroll-to-bottom-btn {
  position: sticky;
  bottom: 12px;
  left: calc(100% - 52px);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--border-color);
  border-radius: 50%;
  background: var(--color-surface);
  color: var(--color-text-secondary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  cursor: pointer;
  z-index: 10;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}

.scroll-to-bottom-btn:hover {
  background: var(--color-accent);
  color: var(--color-bg);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}

.scroll-btn-icon {
  font-size: 18px;
  line-height: 1;
}

/* Transition */
.scroll-btn-enter-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.scroll-btn-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.scroll-btn-enter-from,
.scroll-btn-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
