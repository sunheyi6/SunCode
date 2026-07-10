<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useChatStore } from '../../stores/chat';
import AssistantMessage from './AssistantMessage.vue';
import UserMessage from './UserMessage.vue';

const chatStore = useChatStore();
const messageListRef = ref<HTMLElement | null>(null);
const userScrolledUp = ref(false);
let scrollTimer: ReturnType<typeof setTimeout> | null = null;
let userScrollIntent = false;

function markUserScrollIntent(): void {
  userScrollIntent = true;
}

function markScrollbarPointerIntent(event: PointerEvent): void {
  const el = messageListRef.value;
  if (!el || event.target !== el) return;
  const rect = el.getBoundingClientRect();
  if (event.clientX >= rect.right - 18) {
    markUserScrollIntent();
  }
}

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
  return el.scrollHeight - el.scrollTop - el.clientHeight < 4;
}

function newestBlockContentLength(): number {
  const last = chatStore.messages[chatStore.messages.length - 1];
  if (!last) return 0;
  return (
    last.blocks?.reduce(
      (sum, block) =>
        sum +
        (block.thinking?.length ?? 0) +
        (block.text?.length ?? 0) +
        (block.toolCall?.partialOutput?.length ?? 0),
      0,
    ) ?? 0
  );
}

function newestToolContentLength(): number {
  const last = chatStore.messages[chatStore.messages.length - 1];
  if (!last) return 0;
  return (
    last.toolCalls?.reduce(
      (sum, toolCall) =>
        sum +
        (toolCall.partialOutput?.length ?? 0) +
        (toolCall.result?.output?.length ?? 0) +
        (toolCall.result?.error?.length ?? 0),
      0,
    ) ?? 0
  );
}

/** Composite key for every visible growth source in the newest message. */
let lastKey = '';
function lastMessageContentKey(): string {
  const last = chatStore.messages[chatStore.messages.length - 1];
  if (!last) return '';
  const thinkLen = last.thinking?.length ?? 0;
  const contentLen = last.content?.length ?? 0;
  const blockLen = last.blocks?.length ?? 0;
  const blocksContentLen = newestBlockContentLength();
  const toolOutputLen = newestToolContentLength();
  const tcLen = last.toolCalls?.length ?? 0;
  const tcRunning = last.toolCalls?.filter((t) => t.status === 'running').length ?? 0;
  return `${thinkLen}|${contentLen}|${blockLen}|${blocksContentLen}|${toolOutputLen}|${tcLen}|${tcRunning}`;
}

function onUserScroll(): void {
  if (isAtBottom()) {
    userScrolledUp.value = false;
    userScrollIntent = false;
    return;
  }
  if (userScrollIntent) {
    userScrolledUp.value = true;
    userScrollIntent = false;
  }
}

// Scroll to bottom when a new message is added (user initiated)
watch(
  () => chatStore.messages.length,
  () => {
    if (userScrolledUp.value) return;
    void nextTick().then(() => scrollToBottom());
  },
);

// When the user sends a new message, always re-anchor to the bottom — even if
// they had scrolled up to read history. `addUserMessage` and the follow-up
// `startAssistantMessage` are batched into one flush, so the length watcher
// above would otherwise see the new last message as an (empty) assistant and
// bail out under the `userScrolledUp` guard. Tracking the most recent user
// message id gives us an unambiguous "user just sent" signal.
watch(
  () => {
    for (let i = chatStore.messages.length - 1; i >= 0; i--) {
      if (chatStore.messages[i].role === 'user') return chatStore.messages[i].id;
    }
    return '';
  },
  (id, prev) => {
    if (!id || id === prev) return;
    userScrolledUp.value = false;
    userScrollIntent = false;
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
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      scrollToBottom();
    }, 16);
  },
);

// When streaming finishes, keep the newest content anchored unless the user moved away.
watch(
  () => chatStore.isStreaming,
  (streaming) => {
    if (!streaming && !userScrolledUp.value) {
      setTimeout(() => scrollToBottom(true), 100);
    }
  },
);

onMounted(() => {
  messageListRef.value?.addEventListener('scroll', onUserScroll, { passive: true });
  messageListRef.value?.addEventListener('wheel', markUserScrollIntent, { passive: true });
  messageListRef.value?.addEventListener('touchstart', markUserScrollIntent, { passive: true });
  messageListRef.value?.addEventListener('pointerdown', markScrollbarPointerIntent, {
    passive: true,
  });
});
onUnmounted(() => {
  messageListRef.value?.removeEventListener('scroll', onUserScroll);
  messageListRef.value?.removeEventListener('wheel', markUserScrollIntent);
  messageListRef.value?.removeEventListener('touchstart', markUserScrollIntent);
  messageListRef.value?.removeEventListener('pointerdown', markScrollbarPointerIntent);
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
  /* Always-visible thicker scrollbar, toned to match panel background */
  scrollbar-width: auto;
  scrollbar-color: var(--color-bg-tertiary) var(--color-bg);
}

.message-list::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.message-list::-webkit-scrollbar-track {
  background: var(--color-bg);
}

.message-list::-webkit-scrollbar-thumb {
  background: var(--color-bg-tertiary);
  border-radius: 5px;
  border: 2px solid var(--color-bg);
  background-clip: padding-box;
}

.message-list::-webkit-scrollbar-thumb:hover {
  background: var(--color-overlay);
  border: 2px solid var(--color-bg);
  background-clip: padding-box;
}

.message-list::-webkit-scrollbar-thumb:active {
  background: var(--color-text-muted);
  border: 2px solid var(--color-bg);
  background-clip: padding-box;
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
