<script setup lang="ts">
import type { SubagentResult, ToolCallContent } from '@shared/types';
import { computed, nextTick, ref, watch } from 'vue';
import ToolOperationList from './ToolOperationList.vue';

const props = defineProps<{
  call: ToolCallContent;
}>();

const expanded = ref(true);
const cardBodyRef = ref<HTMLElement | null>(null);
const thinkingRefs = ref<Map<string, HTMLElement>>(new Map());
const outputRefs = ref<Map<string, HTMLElement>>(new Map());

const results = computed<SubagentResult[]>(() => {
  return props.call.result?.subagentResults ?? [];
});

const isRunning = computed(() => props.call.status === 'running');
const isDone = computed(() => props.call.status === 'done');
const isError = computed(() => props.call.status === 'error');

function toggleExpand(): void {
  expanded.value = !expanded.value;
}

function setThinkingRef(agent: string, el: Element | null): void {
  if (el) thinkingRefs.value.set(agent, el as HTMLElement);
}
function setOutputRef(agent: string, el: Element | null): void {
  if (el) outputRefs.value.set(agent, el as HTMLElement);
}

// Auto-scroll thinking and output to bottom as content streams in.
// Also ensures the card itself is visible within parent scroll containers.
watch(
  () => results.value.map(r => `${r.agent}:t${r.thinking?.length ?? 0}:o${r.output?.length ?? 0}:c${r.internalCalls?.length ?? 0}`).join(','),
  () => {
    void nextTick(() => {
      // rAF ensures browser has completed layout before we read scrollHeight
      requestAnimationFrame(() => {
        for (const [, el] of thinkingRefs.value) {
          el.scrollTop = el.scrollHeight;
        }
        for (const [, el] of outputRefs.value) {
          el.scrollTop = el.scrollHeight;
        }
        // Keep the card body visible within parent scroll containers
        // (e.g. .thinking-live-body which clips at 600px)
        cardBodyRef.value?.scrollIntoView({ block: 'end', behavior: 'instant' });
      });
    });
  },
);
</script>

<template>
  <div class="subagent-card" :class="{ running: isRunning, done: isDone, error: isError }">
    <!-- Header -->
    <div class="card-header" @click="toggleExpand()">
      <span class="status-dot" />
      <span class="agent-icon">🤖</span>
      <span class="agent-label">
        <template v-if="results.length === 0">子 Agent 执行中...</template>
        <template v-else>
          {{ results.map(r => r.agent).join(', ') }}
        </template>
      </span>
      <span v-if="isRunning" class="status-badge running-badge">执行中</span>
      <span v-else-if="isError" class="status-badge error-badge">失败</span>
      <span v-else-if="isDone" class="status-badge done-badge">
        {{ results.filter(r => r.success).length }}/{{ results.length }} 完成
      </span>
      <span class="expand-icon">{{ expanded ? '▾' : '▸' }}</span>
    </div>

    <!-- Expanded body: one section per sub-agent result -->
    <div v-if="expanded" ref="cardBodyRef" class="card-body">
      <div v-for="(r, i) in results" :key="i" class="subagent-result">
        <div class="result-header">
          <span class="result-agent">{{ r.agent }}</span>
          <span class="result-tokens">{{ r.tokenUsage.total }} tokens · {{ r.toolCalls }} 步</span>
        </div>

        <!-- Sub-agent's internal thinking -->
        <details v-if="r.thinking" class="sub-thinking" :open="isRunning">
          <summary class="sub-thinking-summary">🧠 思考过程 ({{ r.thinking.length }} 字)</summary>
          <pre class="sub-thinking-text" :ref="(el) => setThinkingRef(r.agent, el as Element)">{{ r.thinking }}</pre>
        </details>

        <!-- Sub-agent's internal tool calls -->
        <div v-if="r.internalCalls && r.internalCalls.length > 0" class="sub-tools">
          <div class="sub-tools-label">🔧 工具调用 ({{ r.internalCalls.length }})</div>
          <ToolOperationList :calls="r.internalCalls" />
        </div>

        <!-- Sub-agent's output -->
        <div v-if="r.output" class="result-output">
          <div class="output-label">{{ r.success ? '✅' : '❌' }} 输出</div>
          <pre class="output-text" :ref="(el) => setOutputRef(r.agent, el as Element)">{{ r.output }}</pre>
        </div>

        <!-- Error -->
        <div v-if="r.error" class="result-error">{{ r.error }}</div>
      </div>

      <!-- Running state (no results yet) -->
      <div v-if="results.length === 0 && isRunning" class="running-hint">
        <span class="spinner" /> 等待子 Agent 返回结果...
      </div>
    </div>
  </div>
</template>

<style scoped>
.subagent-card {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
  margin: 4px 0;
  transition: border-color 0.15s ease;
}

.subagent-card.running { border-color: color-mix(in srgb, var(--color-accent) 40%, transparent); }
.subagent-card.done { border-color: color-mix(in srgb, #2da44e 30%, transparent); }
.subagent-card.error { border-color: color-mix(in srgb, #e5534b 30%, transparent); }

.card-header {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px;
  cursor: pointer; user-select: none;
}
.card-header { transition: background 0.15s ease; }
.card-header:hover { background: var(--color-surface-hover); }

.status-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: var(--color-overlay);
}
.running .status-dot { background: var(--color-accent); animation: pulse 1.2s infinite; }
.done .status-dot { background: #2da44e; }
.error .status-dot { background: #e5534b; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

.agent-icon { font-size: 13px; }
.agent-label { font-size: 13px; font-weight: 550; color: var(--color-text); flex: 1; }
.status-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; font-weight: 600; }
.running-badge { background: color-mix(in srgb, var(--color-accent) 15%, transparent); color: var(--color-accent); }
.done-badge { background: color-mix(in srgb, #2da44e 15%, transparent); color: #2da44e; }
.error-badge { background: color-mix(in srgb, #e5534b 15%, transparent); color: #e5534b; }
.expand-icon { font-size: 11px; color: var(--color-text-muted); }

.card-body {
  border-top: 1px solid var(--border-color);
  padding: 4px 8px;
  display: flex; flex-direction: column; gap: 4px;
}

.subagent-result {
  border-left: 3px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
  padding: 4px 6px;
  margin: 0;
}

.result-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 2px;
}
.result-agent { font-size: 12px; font-weight: 600; color: var(--color-text); }
.result-tokens { font-size: 10px; color: var(--color-text-muted); }

.sub-thinking {
  margin: 2px 0;
  border: 1px solid transparent;
  border-radius: 3px;
  overflow: hidden;
  background: var(--color-bg-tertiary);
}
.sub-thinking-summary {
  font-size: 11px; color: var(--color-text-muted); cursor: pointer;
  padding: 3px 6px;
  user-select: none;
}
.sub-thinking-text {
  font-size: 11px; line-height: 1.15; color: var(--color-text-secondary);
  padding: 3px 6px;
  margin: 0;
  max-height: 300px; overflow-y: auto;
  white-space: pre-wrap; word-break: break-all;
}

.sub-tools { margin: 2px 0; }
.sub-tools-label { font-size: 10px; color: var(--color-text-muted); font-weight: 600; margin-bottom: 1px; }

.result-output { margin: 2px 0; }
.output-label { font-size: 10px; color: var(--color-text-muted); font-weight: 600; }
.output-text {
  font-size: 12px; line-height: 1.2; color: var(--color-text);
  background: var(--color-surface);
  padding: 4px 6px; border-radius: 3px;
  margin: 2px 0 0 0;
  max-height: 300px; overflow-y: auto;
  white-space: pre-wrap; word-break: break-all;
}

.result-error {
  font-size: 11px; color: #e5534b;
  background: color-mix(in srgb, #e5534b 8%, transparent);
  padding: 4px 6px; border-radius: 3px;
}

.running-hint {
  display: flex; align-items: center; gap: 8px;
  font-size: 11px; color: var(--color-text-muted); padding: 4px 0;
}
.spinner {
  width: 12px; height: 12px;
  border: 2px solid var(--border-color);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
