<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ChatMessage } from '../../stores/chat';
import ToolOperationList from '../tools/ToolOperationList.vue';
import StreamingText from './StreamingText.vue';

const props = defineProps<{
  message: ChatMessage;
}>();

const hasContent = computed(() => props.message.content.length > 0);
const hasThinking = computed(() => props.message.isStreaming || Boolean(props.message.thinking));
const copied = ref(false);
const thinkingBodyRef = ref<HTMLElement | null>(null);

// Auto-scroll thinking body to bottom as new text streams in
watch(
  () => props.message.thinking?.length ?? 0,
  () => {
    void nextTick(() => {
      const el = thinkingBodyRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
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

/** Interleaved timeline of thinking text and tool calls in arrival order. */
const thinkingTimeline = computed(() => {
  const thinking = props.message.thinking || '';
  const calls = props.message.toolCalls ?? [];
  type Entry =
    | { type: 'thinking'; text: string }
    | { type: 'tool'; calls: [(typeof calls)[number]] };

  if (calls.length === 0) {
    return thinking ? [{ type: 'thinking' as const, text: thinking }] : [];
  }

  // Sort by thinkingOffset so chunks appear in the order the model produced them
  const sorted = [...calls].sort((a, b) => (a.thinkingOffset ?? 0) - (b.thinkingOffset ?? 0));

  const timeline: Entry[] = [];
  let prevEnd = 0;

  for (const tc of sorted) {
    const start = tc.thinkingOffset ?? 0;
    // Thinking text before this tool call
    if (start > prevEnd) {
      timeline.push({ type: 'thinking', text: thinking.slice(prevEnd, start) });
    } else if (start < prevEnd) {
      // Tool call appeared "before" previous thinking ended (overlapping offsets).
      // Just emit the tool at this position.
    }
    timeline.push({ type: 'tool', calls: [tc] });
    prevEnd = start;
  }

  // Remaining thinking text after the last tool call
  if (prevEnd < thinking.length) {
    timeline.push({ type: 'thinking', text: thinking.slice(prevEnd) });
  }

  return timeline;
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
  if (turn > 0 && max > 0) {
    parts.push(` (${turn} 轮)`);
  }
  if (calls.length > 0) {
    const names = calls
      .slice(0, 3)
      .map((t) => t.name)
      .join(', ');
    const more = calls.length > 3 ? ` 等${calls.length}项` : '';
    parts.push(`· ${names}${more}`);
  }
  return parts.join(' ');
});

async function copyContent() {
  try {
    await navigator.clipboard.writeText(fullTextForCopy.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
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
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  }
}
</script>

<template>
  <div class="assistant-message">
    <div class="message-body">
      <!-- 流式进行中：思考过程内联展示，无折叠，如正文一样可见 -->
      <div v-if="hasThinking && message.isStreaming" class="thinking-live">
        <div class="thinking-live-header">
          <span class="thinking-live-dot" />
          <span>{{ thinkingSummary }}</span>
        </div>
        <div ref="thinkingBodyRef" class="thinking-live-body">
          <template v-for="(entry, i) in thinkingTimeline" :key="i">
            <StreamingText
              v-if="entry.type === 'thinking'"
              :text="entry.text"
              :is-streaming="true"
            />
            <ToolOperationList
              v-else-if="entry.type === 'tool'"
              :calls="entry.calls"
            />
          </template>
        </div>
      </div>

      <!-- 完成后：思考过程折叠 -->
      <details v-else-if="hasThinking" class="thinking-section" :open="false">
        <summary class="thinking-summary">{{ thinkingSummary }}</summary>
        <div class="thinking-content">
          <template v-for="(entry, i) in thinkingTimeline" :key="i">
            <StreamingText
              v-if="entry.type === 'thinking'"
              :text="entry.text"
              :is-streaming="false"
            />
            <ToolOperationList
              v-else-if="entry.type === 'tool'"
              :calls="entry.calls"
            />
          </template>
        </div>
      </details>

      <!-- 正文（思考完成后才显示） -->
      <div v-if="hasContent && !message.isStreaming" class="message-content">
        <StreamingText
          :text="message.content"
          :is-streaming="false"
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

/* ── 流式进行中：思考内联展示 ── */
.thinking-live {
  margin-bottom: 8px;
}

.thinking-live-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-muted);
  margin-bottom: 2px;
}

.thinking-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent, #6c8cff);
  animation: pulse-dot 1.4s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.thinking-live-body {
  font-size: 12px;
  line-height: 1.25;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  max-height: 300px;
  overflow-y: auto;
}

/* Tighten paragraph gaps inside thinking (marked wraps \n\n → <p>) */
.thinking-live-body :deep(p) {
  margin: 0 0 2px 0;
}
.thinking-live-body :deep(br) {
  line-height: 1.1;
}

/* ── 完成后：折叠 ── */
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
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.3;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
  white-space: pre-wrap;
  border-top: 1px solid var(--border-color);
  max-height: 400px;
  overflow-y: auto;
}

.thinking-content :deep(p) {
  margin: 0 0 2px 0;
}
.thinking-content :deep(br) {
  line-height: 1.1;
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
