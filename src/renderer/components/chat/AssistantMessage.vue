<script setup lang="ts">
import type { MemoryEntry } from '@shared/types';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChatMessage } from '../../stores/chat';
import { useSettingsStore } from '../../stores/settings';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';
import { buildInlineCallTrace } from './call-trace-view-model';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import InlineCallTrace from './InlineCallTrace.vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import MemoryDetail from './MemoryDetail.vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import MemoryReference from './MemoryReference.vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import StreamingText from './StreamingText.vue';

const selectedMemory = ref<MemoryEntry | null>(null);
const showMemoryDetail = ref(false);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function handleMemoryClick(memory: MemoryEntry): void {
  selectedMemory.value = memory;
  showMemoryDetail.value = true;
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function handleCloseDetail(): void {
  showMemoryDetail.value = false;
  selectedMemory.value = null;
}

const props = defineProps<{
  message: ChatMessage;
}>();

const settingsStore = useSettingsStore();
const showThinking = computed(() => settingsStore.settings.showThinking !== false);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const hasContent = computed(() => props.message.content.length > 0);
const hasToolCalls = computed(() => (props.message.toolCalls?.length ?? 0) > 0);
const hasThinking = computed(
  () => props.message.isStreaming || Boolean(props.message.thinking) || hasToolCalls.value,
);

const thinkingText = computed(() => props.message.thinking || '');
const inlineTrace = computed(() => buildInlineCallTrace(props.message));
// Drop pure-thinking entries when the user opted out of showing the
// reasoning process. Tool/command entries are always kept — they are the
// "运行逻辑" the UI exists to surface.
const visibleEntries = computed(() =>
  showThinking.value
    ? inlineTrace.value.entries
    : inlineTrace.value.entries.filter((entry) => entry.kind !== 'thinking'),
);
const hasInlineTrace = computed(() => visibleEntries.value.length > 0);
const processEntries = computed(() =>
  visibleEntries.value.filter((entry) => entry.kind !== 'text'),
);
const hasProcessEntries = computed(() => processEntries.value.length > 0);
const uiLanguage = computed(() => props.message.uiLanguage ?? 'zh');

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
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

watch(
  () => props.message.isStreaming,
  (streaming) => {
    if (streaming) startElapsedTimer();
    else {
      elapsedSeconds.value = Math.round((Date.now() - props.message.timestamp) / 1000);
      stopElapsedTimer();
    }
  },
  { immediate: true },
);

onMounted(() => {
  if (props.message.isStreaming) startElapsedTimer();
});
onBeforeUnmount(() => {
  stopElapsedTimer();
});

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
  const time = formattedElapsed.value;

  if (props.message.isStreaming) {
    return `${uiLanguage.value === 'en' ? 'Processing' : '处理中'} ${time}`;
  }

  const parts: string[] = [uiLanguage.value === 'en' ? 'Processed' : '已处理'];
  if (elapsedSeconds.value > 0) parts.push(time);
  return parts.join('  ');
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
      <!-- Streaming: show blocks with previous ones collapsed, current one expanded -->
      <div v-if="hasThinking && message.isStreaming" class="inline-trace inline-trace-live">
        <div class="inline-trace-header">
          <span class="inline-trace-dot" />
          <span>{{ thinkingSummary }}</span>
        </div>
        <InlineCallTrace
          v-if="hasInlineTrace"
          :entries="visibleEntries"
          :ui-language="uiLanguage"
          :is-streaming="message.isStreaming"
          :show-thinking="showThinking"
        />
      </div>

      <!-- Done: keep intermediate process hidden but available on demand -->
      <details v-if="!message.isStreaming && hasProcessEntries" class="thinking-section">
        <summary class="thinking-summary thinking-summary-done">{{ thinkingSummary }}</summary>
        <div class="thinking-content">
          <InlineCallTrace
            :entries="processEntries"
            :ui-language="uiLanguage"
            :is-streaming="false"
            :show-thinking="showThinking"
          />
        </div>
      </details>

      <!-- Render the complete assistant answer in the main content area only
           after streaming. During streaming, text blocks are shown as ordered
           progress entries in InlineCallTrace and remain in the message data. -->
      <div
        v-if="hasContent && !message.isStreaming"
        class="message-content"
        :class="{ streaming: message.isStreaming }"
      >
        <StreamingText :text="message.content" :is-streaming="message.isStreaming" />
      </div>

      <!-- Memory references used in this response -->
      <div
        v-if="message.memoryReferences && message.memoryReferences.length > 0 && !message.isStreaming"
        class="memory-references"
      >
        <div class="memory-references-header">
          <span class="memory-icon" aria-hidden="true"><AppIcon name="brain" :size="14" /></span>
          <span>引用的记忆</span>
        </div>
        <div class="memory-references-list">
          <MemoryReference
            v-for="memory in message.memoryReferences"
            :key="`${memory.date}-${memory.slug}`"
            :memory="memory"
            :compact="false"
            @click="handleMemoryClick(memory)"
          />
        </div>
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

    <MemoryDetail
      v-if="showMemoryDetail && selectedMemory"
      :memory="selectedMemory"
      :visible="showMemoryDetail"
      :show-delete="false"
      @close="handleCloseDetail"
    />
  </div>
</template>

<style scoped>
.assistant-message {
  display: flex; flex-direction: column; align-items: flex-start;
  padding: var(--spacing-sm) var(--spacing-xl);
}
.message-body { max-width: 90%; }

/* -- streaming trace -- */
.inline-trace {
  margin-bottom: var(--spacing-sm);
}

.inline-trace-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
  padding: 2px 0 8px;
  font-weight: 600;
}

.inline-trace-dot {
  width: 10px;
  height: 10px;
  border: 2px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  flex: 0 0 10px;
  animation: streaming-spin 0.7s linear infinite;
}

.trace-fallback-text {
  font-size: 14px;
  line-height: 1.75;
  color: var(--color-text);
  white-space: pre-wrap;
}

/* -- thinking section -- */
.thinking-section {
  margin-bottom: var(--spacing-sm);
}

.thinking-summary {
  padding: 2px 0 8px; font-size: 12px; color: var(--color-text-muted);
  cursor: pointer; user-select: none;
  list-style: none;
}
.thinking-summary::-webkit-details-marker { display: none; }
.thinking-summary::before {
  content: '▸'; display: inline-block; margin-right: 6px;
  font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted);
  transition: transform 0.15s;
}
details[open] > .thinking-summary::before { transform: rotate(90deg); }
.thinking-summary:hover { color: var(--color-text-secondary); }

.thinking-summary-done {
  cursor: pointer;
  opacity: 0.6;
}
.thinking-summary-done::before {
  content: '▸';
  display: inline-block;
  margin-right: 6px;
  font-size: 10px;
  color: var(--color-text-muted);
  transition: transform 0.15s;
}
details[open] > .thinking-summary-done::before {
  content: '▸'; transform: rotate(90deg);
  color: var(--color-text-muted);
}

.thinking-content {
  padding: 0 0 4px;
  color: var(--color-text-secondary);
  max-height: 600px; overflow-y: auto;
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

@keyframes streaming-spin {
  to {
    transform: rotate(360deg);
  }
}

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

/* -- memory references -- */
.memory-references {
  margin-top: var(--spacing-sm);
  padding: var(--spacing-sm);
  background: var(--color-bg-secondary);
  border-radius: var(--border-radius);
  border-left: 3px solid var(--color-accent);
}

.memory-references-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  margin-bottom: var(--spacing-xs);
}

.memory-icon {
  font-size: 14px;
}

.memory-references-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}
</style>
