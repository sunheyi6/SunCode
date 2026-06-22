<script setup lang="ts">
import type { ChatMessage } from '../../stores/chat';

defineProps<{
  message: ChatMessage;
}>();
</script>

<template>
  <div class="user-message">
    <div class="message-bubble">
      <div class="message-text">{{ message.content }}</div>
    </div>
  </div>
</template>

<style scoped>
.user-message {
  display: flex;
  justify-content: flex-end;
  padding: var(--spacing-sm) var(--spacing-xl);
}

.message-bubble {
  max-width: 85%;
  background: var(--color-accent);
  color: var(--color-bg);
  border-radius: 16px 16px 4px 16px;
  padding: 10px 16px;
}

.message-text {
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
