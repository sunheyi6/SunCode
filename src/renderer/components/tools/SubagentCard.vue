<script setup lang="ts">
import type { SubagentResult, ToolCallContent } from '@shared/types';
import { computed, nextTick, ref, watch } from 'vue';
import { buildSubagentInlineTrace } from '../chat/call-trace-view-model';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import InlineCallTrace from '../chat/InlineCallTrace.vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import ToolMarkdownOutput from './ToolMarkdownOutput.vue';

const props = defineProps<{
  call: ToolCallContent;
}>();

const expanded = ref(true);
const cardBodyRef = ref<HTMLElement | null>(null);
const outputRefs = ref<Map<string, HTMLElement>>(new Map());

const results = computed<SubagentResult[]>(() => {
  return props.call.result?.subagentResults ?? [];
});

const isRunning = computed(() => props.call.status === 'running');
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const isDone = computed(() => props.call.status === 'done');
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const isError = computed(() => props.call.status === 'error');

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function toggleExpand(): void {
  expanded.value = !expanded.value;
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function setOutputRef(agent: string, el: Element | null): void {
  if (el) outputRefs.value.set(agent, el as HTMLElement);
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function resultTrace(result: SubagentResult) {
  return buildSubagentInlineTrace(result, isRunning.value);
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function hasResultOutput(result: SubagentResult): boolean {
  return Boolean(result.output && result.output !== '执行中...');
}

// Auto-scroll output to bottom as content streams in.
// Also ensures the card itself is visible within parent scroll containers.
watch(
  () =>
    results.value
      .map(
        (r) =>
          `${r.agent}:t${r.thinking?.length ?? 0}:o${r.output?.length ?? 0}:c${r.internalCalls?.length ?? 0}:b${r.internalBlocks?.length ?? 0}`,
      )
      .join(','),
  () => {
    void nextTick(() => {
      // rAF ensures browser has completed layout before we read scrollHeight
      requestAnimationFrame(() => {
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
          <span class="result-tokens">
            <template v-if="isRunning && r.output === '执行中...'">执行中</template>
            <template v-else>{{ r.tokenUsage.total }} tokens · {{ r.toolCalls }} 步</template>
          </span>
        </div>

        <InlineCallTrace
          v-if="resultTrace(r).entries.length > 0"
          class="sub-inline-trace"
          :entries="resultTrace(r).entries"
          :is-streaming="isRunning"
        />

        <!-- Sub-agent's output -->
        <div v-if="hasResultOutput(r)" class="result-output">
          <div class="output-text" :ref="(el) => setOutputRef(r.agent, el as Element)">
            <ToolMarkdownOutput :output="r.output" />
          </div>
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
  border-radius: 8px;
  overflow: hidden;
  margin: 4px 0;
  transition: border-color 0.15s ease;
}

.subagent-card.running { border-color: color-mix(in srgb, var(--color-accent) 40%, transparent); }
.subagent-card.done { border-color: color-mix(in srgb, var(--color-green) 30%, transparent); }
.subagent-card.error { border-color: color-mix(in srgb, var(--color-red) 30%, transparent); }

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
.running .status-dot {
  background: var(--color-accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-accent) 50%, transparent);
  animation: subagent-breathe 1.4s ease-in-out infinite;
}
.done .status-dot { background: var(--color-green); }
.error .status-dot { background: var(--color-red); }
@keyframes subagent-breathe {
  0%, 100% {
    opacity: 0.4;
    transform: scale(0.8);
    box-shadow: 0 0 2px 0 color-mix(in srgb, var(--color-accent) 30%, transparent);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
    box-shadow: 0 0 8px 2px color-mix(in srgb, var(--color-accent) 60%, transparent);
  }
}

.agent-icon { font-size: 13px; }
.agent-label { font-size: 13px; font-weight: 550; color: var(--color-text); flex: 1; }
.status-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; font-weight: 600; }
.running-badge { background: color-mix(in srgb, var(--color-accent) 15%, transparent); color: var(--color-accent); }
.done-badge { background: color-mix(in srgb, var(--color-green) 15%, transparent); color: var(--color-green); }
.error-badge { background: color-mix(in srgb, var(--color-red) 15%, transparent); color: var(--color-red); }
.expand-icon { font-size: 11px; color: var(--color-text-muted); }

.card-body {
  border-top: 1px solid var(--border-color);
  padding: 8px 10px;
  display: flex; flex-direction: column; gap: 10px;
}

.subagent-result {
  padding: 0;
  margin: 0;
}

.result-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 2px;
}
.result-agent { font-size: 12px; font-weight: 600; color: var(--color-text); }
.result-tokens { font-size: 10px; color: var(--color-text-muted); }

.sub-inline-trace { margin-top: 6px; }

.result-output { margin: 8px 0 0; }
.output-text {
  max-height: 300px; overflow-y: auto;
}

.result-error {
  font-size: 11px; color: var(--color-red);
  background: color-mix(in srgb, var(--color-red) 8%, transparent);
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
