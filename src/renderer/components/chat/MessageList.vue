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

// Scroll to bottom when a new message is added (user or assistant start)
watch(
  () => chatStore.messages.length,
  () => {
    void nextTick().then(() => scrollToBottom());
  },
);

// Scroll to bottom continuously during streaming, as content grows
watch(
  () => {
    const lastMsg = chatStore.messages[chatStore.messages.length - 1];
    return lastMsg?.content;
  },
  () => {
    // During streaming, always scroll to follow the output.
    // When idle, only scroll if user is already near the bottom (let them read history).
    if (chatStore.isStreaming || isNearBottom()) {
      scrollToBottom();
    }
  },
);

// When streaming finishes, do a final scroll to ensure the complete response is visible
watch(
  () => chatStore.isStreaming,
  (streaming) => {
    if (!streaming) {
      // Small delay to let the final DOM update settle, then ensure we're at the bottom
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
