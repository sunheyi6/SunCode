<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ChatMessage } from '../../stores/chat';
import ToolOperationList from '../tools/ToolOperationList.vue';
import StreamingText from './StreamingText.vue';

const props = defineProps<{
  message: ChatMessage;
}>();

const hasContent = computed(() => props.message.content.length > 0);
const hasThinking = computed(
  () => props.message.isStreaming || Boolean(props.message.thinking),
);
const hasToolCalls = computed(() => Boolean(props.message.toolCalls?.length));
const copied = ref(false);

// Auto-expand during streaming, auto-collapse when done.
// The user can still toggle manually.  We sync via @toggle so user
// clicks on <summary> are reflected in the ref.
const thinkingOpen = ref(props.message.isStreaming);
let userToggled = false;

function onThinkingToggle(e: Event) {
  const el = e.target as HTMLDetailsElement;
  thinkingOpen.value = el.open;
  userToggled = true;
}

watch(
  () => props.message.isStreaming,
  (streaming) => {
    if (streaming) {
      // Auto-open when a new round of streaming starts
      thinkingOpen.value = true;
      userToggled = false;
    } else if (!streaming && !userToggled) {
      // Auto-collapse when done, but only if the user hasn't
      // manually toggled during this turn
      thinkingOpen.value = false;
    }
  },
);

const timeLabel = computed(() => {
  const d = new Date(props.message.timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
});

const fullTextForCopy = computed(() => {
  const parts: string[] = [];
  if (props.message.thinking) {
    parts.push(props.message.thinking);
  }
  if (props.message.content) {
    parts.push(props.message.content);
  }
  return parts.join('\n\n');
});

/** Rich summary line for the thinking section.
 *  - Streaming: shows live progress (current tool, completion count).
 *  - Collapsed: shows a compact list of tools that ran. */
const thinkingSummary = computed(() => {
  const calls = props.message.toolCalls ?? [];
  const running = calls.find((t) => t.status === 'running');
  const done = calls.filter((t) => t.status === 'done' || t.status === 'error').length;
  const hasAnyDone = done > 0;
  const hasThinkingText = Boolean(props.message.thinking);
  const turn = props.message.turnCount ?? 0;
  const max = props.message.maxTurns ?? 0;
  const turnLabel = turn > 0 ? `第${turn}轮` : '';

  // --- Streaming / working ---
  if (props.message.isStreaming) {
    // A tool is currently executing
    if (running) {
      return `🧠 ${turnLabel} ${running.name} ${running.arguments ? running.arguments.slice(0, 60) : ''}...`;
    }
    // Tools have completed, waiting for next round of thinking
    if (hasAnyDone) {
      return `🧠 ${turnLabel} 分析结果... (${done}/${calls.length} 完成)`;
    }
    // Pure thinking / waiting for first tool
    if (hasThinkingText) return `🧠 ${turnLabel} 正在思考...`.trim();
    return `🧠 ${turnLabel} 等待模型响应...`.trim();
  }

  // --- Collapsed (done) ---
  const parts: string[] = ['🧠 思考过程'];
  if (max > 0) parts.push(` (${max}轮)`);
  if (calls.length > 0) {
    const names = calls.slice(0, 3).map((t) => t.name).join(', ');
    const more = calls.length > 3 ? ` 等${calls.length}项` : '';
    parts.push(`· ${names}${more}`);
  }
  return parts.join(' ');
});

async function copyContent() {
  try {
    await navigator.clipboard.writeText(fullTextForCopy.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = fullTextForCopy.value;
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
  <div class="assistant-message">
    <div class="message-body">
      <!-- 思考过程（含工具调用）— 流式时自动展开，完成后自动折叠 -->
      <details v-if="hasThinking" class="thinking-section" :open="thinkingOpen" @toggle="onThinkingToggle">
        <summary class="thinking-summary">{{ thinkingSummary }}</summary>
        <div class="thinking-content">
          <StreamingText
            :text="message.thinking || '等待模型返回思考内容…'"
            :is-streaming="message.isStreaming"
          />
          <!-- 工具调用在思考过程内 -->
          <ToolOperationList
            v-if="hasToolCalls && message.toolCalls"
            :calls="message.toolCalls"
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
    </div>
    <div v-if="!message.isStreaming" class="message-footer">
      <span class="message-time">{{ timeLabel }}</span>
      <button
        class="copy-btn"
        :class="{ copied }"
        title="复制回复"
        @click="copyContent"
      >
        {{ copied ? '✓ 已复制' : '📋' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.assistant-message {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
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

.message-footer {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  padding-left: 4px;
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

.assistant-message:hover .copy-btn {
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
