<script setup lang="ts">
import { computed } from 'vue';
import type { ChatMessage } from '../../stores/chat';
import StreamingText from './StreamingText.vue';

const props = defineProps<{
  message: ChatMessage;
}>();

const hasContent = computed(() => props.message.content.length > 0);
const hasThinking = computed(
  () => props.message.isStreaming || Boolean(props.message.thinking),
);
const hasToolCalls = computed(() => Boolean(props.message.toolCalls?.length));
</script>

<template>
  <div class="assistant-message">
    <div class="message-body">
      <!-- 思考过程 -->
      <details v-if="hasThinking" class="thinking-section">
        <summary class="thinking-summary">
          {{ message.isStreaming ? '🧠 正在思考...' : '🧠 思考过程' }}
        </summary>
        <div class="thinking-content">
          <StreamingText
            :text="message.thinking || '等待模型返回思考内容…'"
            :is-streaming="message.isStreaming"
          />
        </div>
      </details>

      <!-- 正文 -->
      <div v-if="hasContent" class="message-content">
        <StreamingText
          :text="message.content"
          :is-streaming="message.isStreaming"
        />
      </div>

      <!-- 等待中 -->
      <div v-if="message.isStreaming && !hasContent && !hasThinking" class="streaming-indicator">
        <span class="dot" />
        <span class="dot" />
        <span class="dot" />
      </div>

      <!-- 工具调用 -->
      <div v-if="hasToolCalls && message.toolCalls" class="tool-calls">
        <div
          v-for="tc in message.toolCalls"
          :key="tc.id"
          class="tool-call-badge"
        >
          🔧 {{ tc.name }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.assistant-message {
  padding: var(--spacing-sm) var(--spacing-xl);
}

.message-body {
  max-width: 90%;
}

.thinking-section {
  margin-bottom: var(--spacing-sm);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  overflow: hidden;
}

.thinking-summary {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--color-text-secondary);
  cursor: pointer;
  background: var(--color-surface);
  user-select: none;
}

.thinking-content {
  padding: 8px 12px;
  font-size: 13px;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
  white-space: pre-wrap;
  border-top: 1px solid var(--border-color);
}

.message-content {
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-text);
}

.streaming-indicator {
  display: flex;
  gap: 4px;
  padding: 8px 0;
}

.dot {
  width: 6px;
  height: 6px;
  background: var(--color-text-muted);
  border-radius: 50%;
  animation: pulse 1.4s ease-in-out infinite both;
}

.dot:nth-child(2) { animation-delay: 0.16s; }
.dot:nth-child(3) { animation-delay: 0.32s; }

@keyframes pulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

.tool-calls {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}

.tool-call-badge {
  font-size: 12px;
  padding: 2px 8px;
  background: var(--color-surface);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  color: var(--color-text-secondary);
}
</style>
