<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChatMessage } from '../../stores/chat';

const props = defineProps<{
  message: ChatMessage;
}>();

const copied = ref(false);

const timeLabel = computed(() => {
  const d = new Date(props.message.timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
});

async function copyContent(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  }
}
</script>

<template>
  <div class="user-message">
    <div class="message-bubble">
      <div class="message-text">{{ message.content }}</div>
    </div>
    <div class="message-footer">
      <span class="message-time">{{ timeLabel }}</span>
      <button
        class="copy-btn"
        :class="{ copied }"
        title="复制消息"
        @click="copyContent(message.content)"
      >
        {{ copied ? '✓ 已复制' : '📋' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.user-message {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
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

.message-footer {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  padding-right: 4px;
}

.message-time {
  font-size: 11px;
  color: var(--color-text-muted);
}

.copy-btn {
  padding: 1px 4px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.15s;
  color: var(--color-text-muted);
  border-radius: 4px;
}

.user-message:hover .copy-btn {
  opacity: 0.7;
}

.copy-btn:hover {
  opacity: 1 !important;
  background: var(--color-surface);
}

.copy-btn.copied {
  opacity: 1;
  color: var(--color-green);
  font-size: 11px;
}
</style>
