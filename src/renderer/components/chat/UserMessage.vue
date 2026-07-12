<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChatMessage } from '../../stores/chat';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';

const props = defineProps<{
  message: ChatMessage;
}>();

const copied = ref(false);
const expanded = ref(false);

const isLongContent = computed(() => {
  const content = props.message.content;
  const lineCount = content.split('\n').length;
  return lineCount > 6 || content.length > 500;
});

function toggleExpand() {
  expanded.value = !expanded.value;
}

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
    setTimeout(() => {
      copied.value = false;
    }, 1500);
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
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  }
}
</script>

<template>
  <div class="user-message">
    <div class="message-bubble">
      <div
        class="message-text"
        :class="{ collapsed: isLongContent && !expanded }"
      >{{ message.content }}</div>
      <button
        v-if="isLongContent"
        class="expand-btn"
        @click="toggleExpand"
      >
        <AppIcon :name="expanded ? 'chevron-up' : 'chevron-down'" :size="12" />
        {{ expanded ? '收起' : `展开更多 ${message.content.split('\n').length} 行` }}
      </button>
    </div>
    <div class="message-footer">
      <span class="message-time">{{ timeLabel }}</span>
      <button
        class="copy-btn"
        :class="{ copied }"
        title="复制消息"
        @click="copyContent(message.content)"
      >
        <AppIcon :name="copied ? 'check' : 'copy'" :size="12" />
        {{ copied ? '已复制' : '' }}
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
  background: var(--color-bubble-user);
  color: var(--color-bubble-user-text);
  border-radius: 18px 18px 6px 18px;
  padding: 10px 16px;
}

.message-text {
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-text.collapsed {
  max-height: 160px;
  overflow: hidden;
  position: relative;
}

.expand-btn {
  display: block;
  margin-top: 6px;
  padding: 2px 8px;
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  cursor: pointer;
  font-size: 11px;
  color: var(--color-text-muted);
  transition: all 0.12s ease;
}

.expand-btn:hover {
  background: color-mix(in srgb, var(--color-text-muted) 10%, transparent);
  color: var(--color-text);
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
  display: inline-flex;
  align-items: center;
  gap: 4px;
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
