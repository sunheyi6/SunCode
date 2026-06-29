<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import type { ToolCallContent } from '@shared/types';
import { commandSummary, parseToolArguments } from '../../utils/tool-presentation';

const props = defineProps<{
  call: ToolCallContent;
}>();

const streamingPre = ref<HTMLPreElement | null>(null);

const args = computed(() => parseToolArguments(props.call.arguments));
const details = computed(() =>
  props.call.result?.details?.type === 'command' ? props.call.result.details : undefined,
);

const title = computed(() => commandSummary(args.value));

const isFailed = computed(
  () =>
    props.call.status === 'error' ||
    props.call.result?.success === false ||
    (details.value?.exitCode !== null &&
      details.value?.exitCode !== undefined &&
      details.value.exitCode !== 0),
);

const isRunning = computed(() => props.call.status === 'running');
const streamingOutput = computed(() => props.call.partialOutput || '');

// Auto-scroll to bottom of streaming output
watch(streamingOutput, async () => {
  await nextTick();
  if (streamingPre.value) {
    streamingPre.value.scrollTop = streamingPre.value.scrollHeight;
  }
});

const exitCodeLabel = computed(() => {
  if (details.value?.exitCode === null || details.value?.exitCode === undefined) return '—';
  return String(details.value.exitCode);
});
</script>

<template>
  <details class="command-operation" :class="{ 'command-failed': isFailed, 'command-running': isRunning }" :open="isRunning">
    <summary class="command-summary">
      <span class="command-icon">▸</span>
      <span class="command-title">{{ title }}</span>
      <span class="command-status">{{ isRunning ? '执行中' : isFailed ? '失败' : '完成' }}</span>
      <span class="command-exit-code" v-if="!isRunning">退出码：{{ exitCodeLabel }}</span>
    </summary>
    <div class="command-body">
      <div class="command-field">
        <span class="field-label">命令</span>
        <pre><code>{{ details?.command || args.command || '' }}</code></pre>
      </div>
      <div class="command-meta" v-if="!isRunning">
        <span>工作目录：{{ details?.cwd || '等待执行' }}</span>
        <span>退出码：{{ exitCodeLabel }}</span>
        <span v-if="details?.signal">终止信号：{{ details.signal }}</span>
      </div>
      <section v-if="isRunning && streamingOutput" class="command-section streaming">
        <h4>实时输出</h4>
        <pre ref="streamingPre">{{ streamingOutput }}</pre>
      </section>
      <section v-if="!isRunning" class="command-section">
        <h4>标准输出</h4>
        <pre>{{ details?.stdout || '无输出' }}</pre>
      </section>
      <section v-if="!isRunning && details?.stderr" class="command-section">
        <h4>错误输出</h4>
        <pre>{{ details.stderr }}</pre>
      </section>
    </div>
  </details>
</template>

<style scoped>
.command-operation {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  font-size: 12px;
  overflow: hidden;
}

.command-failed {
  border-color: rgba(243, 139, 168, 0.3);
}

.command-running {
  border-color: var(--color-accent);
}

.command-running .command-status {
  color: var(--color-accent);
}

.command-running .command-summary {
  cursor: default;
}

.command-summary {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-md);
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.command-summary::-webkit-details-marker {
  display: none;
}

.command-icon {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: 10px;
  transition: transform 0.15s ease;
}

details[open] .command-icon {
  transform: rotate(90deg);
}

.command-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-secondary);
}

.command-status {
  flex-shrink: 0;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--color-green);
}

.command-failed .command-status {
  color: var(--color-red);
}

.command-exit-code {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
}

.command-body {
  padding: var(--spacing-xs) var(--spacing-md) var(--spacing-md);
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.command-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.field-label {
  font-size: 10px;
  color: var(--color-text-muted);
  text-transform: uppercase;
}

.command-field pre,
.command-section pre {
  margin: 0;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--color-bg-secondary);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

.command-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-md);
  font-size: 11px;
  color: var(--color-text-muted);
}

.command-section h4 {
  margin: 0 0 2px;
  font-size: 10px;
  color: var(--color-text-muted);
  text-transform: uppercase;
  font-weight: 500;
}

.command-section.streaming pre {
  max-height: 300px;
  background: var(--color-bg-tertiary);
  border: 1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);
}
</style>
