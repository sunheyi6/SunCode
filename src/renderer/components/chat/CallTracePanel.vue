<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChatMessage } from '../../stores/chat';
import ToolOperationList from '../tools/ToolOperationList.vue';
import StreamingText from '../chat/StreamingText.vue';

const SYSTEM_PROMPT_PREVIEW_LEN = 500;
const ANSWER_COLLAPSE_LEN = 400;
const showFullSystemPrompt = ref(false);

const props = defineProps<{
  messages: ChatMessage[];
  systemPrompt: string;
}>();

defineEmits<{
  close: [];
}>();

/** Only assistant messages that have thinking or tool calls. */
const traceMessages = computed(() =>
  props.messages.filter(
    (m) =>
      m.role === 'assistant' && (m.thinking || (m.toolCalls && m.toolCalls.length > 0) || m.content),
  ),
);

/** Build interleaved timeline for a single message. */
function messageTimeline(msg: ChatMessage) {
  const thinking = msg.thinking || '';
  const calls = msg.toolCalls ?? [];
  type Entry =
    | { type: 'thinking'; text: string }
    | { type: 'tool'; calls: typeof calls };

  if (calls.length === 0) {
    return thinking ? [{ type: 'thinking' as const, text: thinking }] : [];
  }

  const sorted = [...calls].sort((a, b) => (a.thinkingOffset ?? 0) - (b.thinkingOffset ?? 0));
  const timeline: Entry[] = [];
  let prevEnd = 0;

  for (const tc of sorted) {
    const start = tc.thinkingOffset ?? 0;
    if (start > prevEnd) {
      timeline.push({ type: 'thinking', text: thinking.slice(prevEnd, start) });
    }
    timeline.push({ type: 'tool', calls: [tc] });
    prevEnd = start;
  }
  if (prevEnd < thinking.length) {
    timeline.push({ type: 'thinking', text: thinking.slice(prevEnd) });
  }
  return timeline;
}

const systemPromptPreview = computed(() => {
  if (showFullSystemPrompt.value || props.systemPrompt.length <= SYSTEM_PROMPT_PREVIEW_LEN) {
    return props.systemPrompt;
  }
  return props.systemPrompt.slice(0, SYSTEM_PROMPT_PREVIEW_LEN) + '...';
});

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
</script>

<template>
  <aside class="call-trace-panel">
    <div class="trace-header">
      <span class="trace-title">📋 调用轨迹</span>
      <button class="trace-close" @click="$emit('close')" title="关闭">✕</button>
    </div>

    <div class="trace-body">
      <!-- System Prompt -->
      <details v-if="systemPrompt" class="trace-section">
        <summary class="trace-section-header">
          <span>📝 系统提示词</span>
          <span class="trace-section-meta">{{ systemPrompt.length }} 字符</span>
        </summary>
        <pre class="trace-pre">{{ systemPromptPreview }}</pre>
        <button
          v-if="systemPrompt.length > SYSTEM_PROMPT_PREVIEW_LEN"
          class="trace-expand-btn"
          @click="showFullSystemPrompt = !showFullSystemPrompt"
        >
          {{ showFullSystemPrompt ? '收起' : `展开全文 (${systemPrompt.length} 字符)` }}
        </button>
      </details>

      <!-- Empty state -->
      <div v-if="traceMessages.length === 0" class="trace-empty">
        暂无调用记录。开始对话后将在此显示调用轨迹。
      </div>

      <!-- Each assistant message -->
      <div
        v-for="(msg, mi) in traceMessages"
        :key="msg.id"
        class="trace-message"
      >
        <div class="trace-msg-header">
          <span class="trace-msg-label">
            {{ msg.isStreaming ? '🔄 进行中' : '✅ Agent 助手' }}
          </span>
          <span class="trace-msg-time">{{ formatTime(msg.timestamp) }}</span>
        </div>

        <!-- Timeline: thinking + tool calls interleaved, thinking collapsed by default -->
        <template v-for="(entry, ei) in messageTimeline(msg)" :key="`${msg.id}-${ei}`">
          <details v-if="entry.type === 'thinking' && entry.text" class="trace-thinking-details">
            <summary class="trace-thinking-summary">
              <span>🧠 思考过程</span>
              <span class="trace-section-meta">{{ entry.text.length }} 字符</span>
            </summary>
            <div class="trace-thinking">
              <StreamingText :text="entry.text" :is-streaming="false" />
            </div>
          </details>
          <ToolOperationList
            v-else-if="entry.type === 'tool'"
            :calls="entry.calls"
          />
        </template>

        <!-- Final text answer (collapsed when long) -->
        <div v-if="msg.content && !msg.isStreaming" class="trace-answer">
          <details v-if="msg.content.length > ANSWER_COLLAPSE_LEN" class="trace-answer-details">
            <summary class="trace-answer-summary">
              <span>📝 回复内容</span>
              <span class="trace-section-meta">{{ msg.content.length }} 字符</span>
            </summary>
            <StreamingText :text="msg.content" :is-streaming="false" />
          </details>
          <StreamingText v-else :text="msg.content" :is-streaming="false" />
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.call-trace-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--color-bg);
  border-left: 1px solid var(--border-color);
  overflow: hidden;
}

.trace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  height: 38px;
  min-height: 38px;
  border-bottom: 1px solid var(--border-color);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.trace-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}

.trace-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 14px;
}

.trace-close:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.trace-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* Sections */
.trace-section {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  overflow: hidden;
  flex-shrink: 0;
}

.trace-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-text-secondary);
  cursor: pointer;
  background: var(--color-surface);
  user-select: none;
  list-style: none;
}

.trace-section-header::-webkit-details-marker {
  display: none;
}

.trace-section-meta {
  font-size: 10px;
  color: var(--color-text-muted);
  flex-shrink: 0;
  margin-left: 8px;
}

.trace-pre {
  margin: 0;
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.5;
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
  max-height: 400px;
  overflow-y: auto;
  background: var(--color-bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.trace-expand-btn {
  display: block;
  width: 100%;
  padding: 5px 10px;
  border: none;
  border-top: 1px solid var(--border-color);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s;
}

.trace-expand-btn:hover {
  color: var(--color-accent);
}

/* Messages */
.trace-message {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  overflow: hidden;
  flex-shrink: 0;
}

.trace-msg-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  background: var(--color-surface);
  font-size: 11px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.trace-msg-label {
  color: var(--color-text);
  font-weight: 500;
}

.trace-msg-time {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  flex-shrink: 0;
  margin-left: 8px;
}

.trace-answer {
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.4;
  border-top: 1px solid var(--border-color);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}

/* Tighten markdown spacing inside trace panel (override StreamingText defaults) */
.trace-answer :deep(.markdown-content p) {
  margin: 0 0 3px 0;
}

.trace-answer :deep(.markdown-content pre) {
  margin: 4px 0;
}

.trace-answer :deep(.markdown-content ul),
.trace-answer :deep(.markdown-content ol) {
  margin: 2px 0;
}

.trace-answer :deep(.markdown-content li) {
  margin: 0;
}

.trace-answer :deep(.markdown-content h1),
.trace-answer :deep(.markdown-content h2),
.trace-answer :deep(.markdown-content h3) {
  margin: 6px 0 4px 0;
}

.trace-answer :deep(.markdown-content blockquote) {
  margin: 4px 0;
}

.trace-answer :deep(.markdown-content table) {
  margin: 4px 0 6px 0;
}

.trace-answer :deep(.streaming-text) {
  line-height: 1.35;
}

/* Collapsible answer details */
.trace-answer-details {
  overflow: hidden;
}

.trace-answer-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 11px;
  color: var(--color-text-muted);
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.trace-answer-summary::-webkit-details-marker {
  display: none;
}

.trace-answer-summary:hover {
  color: var(--color-text-secondary);
}

/* Collapsible thinking details (default collapsed in call trace) */
.trace-thinking-details {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  overflow: hidden;
  flex-shrink: 0;
}

.trace-thinking-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  cursor: pointer;
  background: var(--color-surface);
  user-select: none;
  list-style: none;
}

.trace-thinking-summary::-webkit-details-marker {
  display: none;
}

.trace-thinking-summary:hover {
  color: var(--color-text-secondary);
}

/* Also tighten thinking text spacing */
.trace-thinking {
  padding: 4px 8px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
  max-height: 300px;
  overflow-y: auto;
}

.trace-thinking :deep(.markdown-content p) {
  margin: 0 0 2px 0;
}

.trace-thinking :deep(.streaming-text) {
  line-height: 1.3;
}

.trace-empty {
  text-align: center;
  padding: 32px 16px;
  font-size: 12px;
  color: var(--color-text-muted);
}
</style>
