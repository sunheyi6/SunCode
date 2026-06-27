<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChatMessage } from '../../stores/chat';
import CompactToolBar from '../tools/CompactToolBar.vue';
import ToolOperationList from '../tools/ToolOperationList.vue';
import StreamingText from './StreamingText.vue';

const props = defineProps<{
  message: ChatMessage;
}>();

const hasContent = computed(() => props.message.content.length > 0);
const hasToolCalls = computed(() =>
  (props.message.toolCalls?.length ?? 0) > 0
);
const hasThinking = computed(() =>
  props.message.isStreaming ||
  Boolean(props.message.thinking) ||
  hasToolCalls.value
);

const copied = ref(false);

// -- elapsed time --
const elapsedSeconds = ref(0);
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

function startElapsedTimer(): void {
  stopElapsedTimer();
  elapsedSeconds.value = Math.round((Date.now() - props.message.timestamp) / 1000);
  elapsedTimer = setInterval(() => {
    elapsedSeconds.value = Math.round((Date.now() - props.message.timestamp) / 1000);
  }, 1000);
}

function stopElapsedTimer(): void {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

watch(() => props.message.isStreaming, (streaming) => {
  if (streaming) startElapsedTimer();
  else { elapsedSeconds.value = Math.round((Date.now() - props.message.timestamp) / 1000); stopElapsedTimer(); }
}, { immediate: true });

onMounted(() => { if (props.message.isStreaming) startElapsedTimer(); });
onBeforeUnmount(() => { stopElapsedTimer(); });

const formattedElapsed = computed(() => {
  const s = elapsedSeconds.value;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remain = s % 60;
  return remain > 0 ? `${m}m${remain}s` : `${m}m`;
});

const timeLabel = computed(() => {
  const d = new Date(props.message.timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
});

const fullTextForCopy = computed(() => {
  const parts: string[] = [];
  if (props.message.thinking) parts.push(props.message.thinking);
  if (props.message.content) parts.push(props.message.content);
  return parts.join('\n\n');
});

const thinkingSummary = computed(() => {
  const calls = props.message.toolCalls ?? [];
  const running = calls.find((t) => t.status === 'running');
  const done = calls.filter((t) => t.status === 'done' || t.status === 'error').length;
  const time = formattedElapsed.value;

  if (props.message.isStreaming) {
    if (running) {
      const shortArgs = running.arguments ? running.arguments.slice(0, 50) : '';
      return `[${running.name}] ${shortArgs}  ${time}`;
    }
    if (done > 0) return `[工具] ${done}/${calls.length} 完成  ${time}`;
    return `[等待响应] ${time}`;
  }

  const parts: string[] = ['思考过程'];
  const turn = props.message.turnCount ?? 0;
  if (turn > 0) parts.push(`${turn}次请求`);
  if (elapsedSeconds.value > 0) parts.push(time);
  if (calls.length > 0) {
    const names = calls.slice(0, 3).map((t) => t.name).join(', ');
    const more = calls.length > 3 ? ` +${calls.length - 3}` : '';
    parts.push(names + more);
  }
  return parts.join('  ');
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
      <!-- Streaming: compact tool bar with live status -->
      <div v-if="hasThinking && message.isStreaming" class="thinking-live">
        <div class="thinking-live-header">
          <span class="thinking-live-dot" />
          <span>{{ thinkingSummary }}</span>
        </div>
        <CompactToolBar
          v-if="(message.toolCalls?.length ?? 0) > 0"
          :calls="message.toolCalls ?? []"
        />
      </div>

      <!-- Done: collapsed thinking with tool diffs hidden inside -->
      <details v-if="!message.isStreaming && hasThinking" class="thinking-section">
        <summary class="thinking-summary thinking-summary-done">{{ thinkingSummary }}</summary>
        <div class="thinking-content">
          <ToolOperationList
            v-if="hasToolCalls"
            :calls="message.toolCalls ?? []"
          />
          <div v-else class="thinking-no-tools">无工具调用</div>
        </div>
      </details>

      <!-- Visible reply text -->
      <div v-if="hasContent" class="message-content" :class="{ streaming: message.isStreaming }">
        <StreamingText :text="message.content" :is-streaming="message.isStreaming" />
      </div>

      <!-- Waiting for first response -->
      <div v-if="message.isStreaming && !hasContent && !hasThinking" class="streaming-indicator">
        <span class="dot" /><span class="dot" /><span class="dot" />
      </div>
    </div>
    <div v-if="!message.isStreaming" class="message-footer">
      <span class="message-time">{{ timeLabel }}</span>
      <button class="copy-btn" :class="{ copied }" title="复制回复" @click="copyContent">
        {{ copied ? '已复制' : '复制' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.assistant-message {
  display: flex; flex-direction: column; align-items: flex-start;
  padding: var(--spacing-sm) var(--spacing-xl);
}
.message-body { max-width: 90%; }

/* -- streaming live -- */
.thinking-live { margin-bottom: 8px; }

.thinking-live-header {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--color-text-muted); margin-bottom: 2px;
}

.thinking-live-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-accent);
  animation: pulse-dot 1.4s ease-in-out infinite;
}

@keyframes pulse-dot { 0%,100%{opacity:.4} 50%{opacity:1} }

/* -- collapsed -- */
.thinking-section {
  margin-bottom: var(--spacing-sm);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  overflow: hidden;
  background: var(--color-bg-tertiary);
}

.thinking-summary {
  padding: 6px 12px; font-size: 12px; color: var(--color-text-secondary);
  cursor: pointer; background: var(--color-surface); user-select: none;
  list-style: none;
}
.thinking-summary::-webkit-details-marker { display: none; }
.thinking-summary::before {
  content: '>'; display: inline-block; margin-right: 6px;
  font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted);
  transition: transform 0.15s;
}
details[open] > .thinking-summary::before { transform: rotate(90deg); }
.thinking-summary:hover { background: var(--color-surface-hover); }

.thinking-summary-done {
  cursor: pointer;
  opacity: 0.6;
}
.thinking-summary-done::before {
  content: '✓';
  display: inline-block;
  margin-right: 6px;
  font-size: 10px;
  color: var(--color-green);
  transition: transform 0.15s;
}
details[open] > .thinking-summary-done::before {
  content: '>'; transform: rotate(90deg);
  color: var(--color-text-muted);
}

.thinking-content {
  padding: 6px 10px; font-size: 12px; line-height: 1.2;
  color: var(--color-text-secondary); background: var(--color-bg);
  max-height: 400px; overflow-y: auto;
}

.thinking-no-tools {
  font-size: 11px; color: var(--color-text-muted); font-style: italic;
  padding: 4px 0;
}

/* -- reply text -- */
.message-content { font-size: 14px; line-height: 1.6; color: var(--color-text); }

.message-content.streaming {
  color: var(--color-text-secondary); font-size: 13px; line-height: 1.5;
  padding: 4px 0; border-left: 2px solid var(--color-accent);
  padding-left: 10px; margin: 4px 0;
}

/* -- waiting dots -- */
.streaming-indicator { display: flex; gap: 4px; padding: 8px 0; }

.dot {
  width: 6px; height: 6px; background: var(--color-text-muted);
  border-radius: 50%; animation: pulse 1.4s ease-in-out infinite both;
}
.dot:nth-child(2) { animation-delay: 0.16s; }
.dot:nth-child(3) { animation-delay: 0.32s; }

@keyframes pulse { 0%,80%,100%{opacity:.3;transform:scale(.8)} 40%{opacity:1;transform:scale(1)} }

/* -- footer -- */
.message-footer { display: flex; align-items: center; gap: 4px; margin-top: 2px; padding-left: 4px; }
.message-time { font-size: 11px; color: var(--color-text-muted); }

.copy-btn {
  padding: 1px 4px; background: none; border: none; cursor: pointer;
  font-size: 12px; opacity: 0; transition: opacity 0.15s;
  color: var(--color-text-muted); border-radius: 4px;
}
.assistant-message:hover .copy-btn { opacity: 0.7; }
.copy-btn:hover { opacity: 1 !important; background: var(--color-surface); }
.copy-btn.copied { opacity: 1; color: var(--color-green); font-size: 11px; }
</style>
