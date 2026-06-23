<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useChatStore } from '../../stores/chat';
import AssistantMessage from './AssistantMessage.vue';
import UserMessage from './UserMessage.vue';

const chatStore = useChatStore();
const messageListRef = ref<HTMLElement | null>(null);

/** Scroll to the bottom of the message list, after DOM layout is complete. */
function scrollToBottom(): void {
  const el = messageListRef.value;
  if (!el) return;

  // Double rAF ensures the browser has finished layout after v-html updates
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  });
}

/** Check if the user is visually near the bottom of the scroll area. */
function isNearBottom(): boolean {
  const el = messageListRef.value;
  if (!el) return false;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

/** Composite key that triggers a scroll when any live content changes. */
function lastMessageContentKey(): string {
  const last = chatStore.messages[chatStore.messages.length - 1];
  if (!last) return '';
  const tcLen = last.toolCalls?.length ?? 0;
  const tcRunning = last.toolCalls?.filter((t) => t.status === 'running').length ?? 0;
  return `${last.thinking?.length ?? 0}|${last.content.length}|${tcLen}|${tcRunning}`;
}

// Scroll to bottom when a new message is added
watch(
  () => chatStore.messages.length,
  () => {
    void nextTick().then(() => scrollToBottom());
  },
);

// During streaming, scroll continuously as thinking / content / tool calls grow
watch(
  () => lastMessageContentKey(),
  () => {
    if (chatStore.isStreaming || isNearBottom()) {
      scrollToBottom();
    }
  },
);

// When streaming finishes, ensure the complete response is visible
watch(
  () => chatStore.isStreaming,
  (streaming) => {
    if (!streaming) {
      setTimeout(() => scrollToBottom(), 50);
    }
  },
);
</script>

<template>
  <div class="message-list" ref="messageListRef">
    <!-- 消息列表 -->
    <template v-for="msg in chatStore.messages" :key="msg.id">
      <UserMessage v-if="msg.role === 'user'" :message="msg" />
      <AssistantMessage v-else-if="msg.role === 'assistant'" :message="msg" />
    </template>
  </div>
</template>

<style scoped>
.message-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-md) 0;
}
</style>
