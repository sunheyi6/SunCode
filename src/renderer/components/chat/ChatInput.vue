<script setup lang="ts">
import { nextTick, ref } from 'vue';

defineProps<{
  isStreaming: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
}>();

const inputText = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);

async function handleSend(): Promise<void> {
  const text = inputText.value.trim();
  if (!text) return;

  emit('send', text);

  // 确保清空：先改 ref，再等 DOM 更新
  inputText.value = '';
  await nextTick();
  // 兜底：直接操作 DOM
  if (textareaRef.value) {
    textareaRef.value.value = '';
  }
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}
</script>

<template>
  <div class="chat-input">
    <div class="input-container">
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="input-field"
        placeholder="输入问题，例如：解释一下这个项目的认证流程..."
        rows="2"
        @keydown="handleKeydown"
        :disabled="false"
      />
      <button
        class="send-btn"
        :class="{ queued: isStreaming }"
        @click="handleSend"
      >
        {{ isStreaming ? '＋ 排队' : '↑ 发送' }}
      </button>
    </div>
    <div class="input-hint">
      {{ isStreaming ? 'Enter 加入等待队列' : 'Enter 发送' }} · Shift+Enter 换行
    </div>
  </div>
</template>

<style scoped>
.chat-input {
  padding: var(--spacing-md) var(--spacing-xl);
  border-top: 1px solid var(--border-color);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.input-container {
  display: flex;
  gap: var(--spacing-sm);
  align-items: flex-end;
}

.input-field {
  flex: 1;
  resize: none;
  min-height: 48px;
  max-height: 200px;
  font-size: 14px;
  line-height: 1.5;
  padding: 10px 14px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  color: var(--color-text);
  outline: none;
  font-family: var(--font-sans);
  transition: border-color 0.15s;
}

.input-field:focus {
  border-color: var(--color-accent);
}

.input-field::placeholder {
  color: var(--color-text-muted);
}

.send-btn {
  flex-shrink: 0;
  padding: 10px 20px;
  font-size: 13px;
  font-weight: 600;
  border-radius: var(--border-radius);
  background: var(--color-accent);
  color: var(--color-bg);
  border: none;
  cursor: pointer;
  transition: background 0.15s;
}

.send-btn:hover {
  background: var(--color-accent-hover);
}

.send-btn.queued {
  background: var(--color-purple);
}

.send-btn.queued:hover {
  opacity: 0.9;
}

.input-hint {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 4px;
  text-align: right;
}
</style>
