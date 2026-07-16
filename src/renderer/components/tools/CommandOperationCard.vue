<script setup lang="ts">
import type { ToolCallContent } from '@shared/types';
import { computed, nextTick, ref, watch } from 'vue';
import { commandSummary, parseToolArguments } from '../../utils/tool-presentation';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import ToolMarkdownOutput from './ToolMarkdownOutput.vue';

const props = defineProps<{
  call: ToolCallContent;
}>();

const streamingOutputRef = ref<HTMLElement | null>(null);

const args = computed(() => parseToolArguments(props.call.arguments));
const details = computed(() =>
  props.call.result?.details?.type === 'command' ? props.call.result.details : undefined,
);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const title = computed(() => commandSummary(args.value));
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const commandText = computed(() => (details.value?.command || args.value.command || '') as string);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const isFailed = computed(
  () =>
    props.call.status === 'error' ||
    props.call.result?.success === false ||
    (details.value?.exitCode !== null &&
      details.value?.exitCode !== undefined &&
      details.value.exitCode !== 0),
);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const isRunning = computed(() => props.call.status === 'running');
const streamingOutput = computed(() => props.call.partialOutput || '');

const OUTPUT_PREVIEW_LINES = 5;
const stdoutExpanded = ref(false);
const stderrExpanded = ref(false);

function previewLines(text: string, expanded: boolean): { text: string; hidden: number } {
  const lines = text.split('\n');
  if (expanded || lines.length <= OUTPUT_PREVIEW_LINES) {
    return { text, hidden: 0 };
  }
  return {
    text: lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n'),
    hidden: lines.length - OUTPUT_PREVIEW_LINES,
  };
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const stdoutPreview = computed(() =>
  previewLines(details.value?.stdout || '', stdoutExpanded.value),
);
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const stderrPreview = computed(() =>
  previewLines(details.value?.stderr || '', stderrExpanded.value),
);

watch(streamingOutput, async () => {
  await nextTick();
  if (streamingOutputRef.value) {
    streamingOutputRef.value.scrollTop = streamingOutputRef.value.scrollHeight;
  }
});

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const exitCodeLabel = computed(() => {
  if (details.value?.exitCode === null || details.value?.exitCode === undefined) return '-';
  return String(details.value.exitCode);
});
</script>

<template>
  <details class="command-operation" :class="{ 'command-failed': isFailed, 'command-running': isRunning }" :open="isRunning">
    <summary class="command-summary" :class="{ 'running-scan': isRunning }">
      <span class="command-icon"><AppIcon name="terminal" :size="13" /></span>
      <span v-if="isRunning" class="command-breathe-dot" />
      <span class="command-title">{{ title }}</span>
      <span class="command-status">{{ isRunning ? '执行中' : isFailed ? '失败' : '完成' }}</span>
      <span v-if="!isRunning" class="command-exit-code">退出码：{{ exitCodeLabel }}</span>
    </summary>
    <div class="command-body">
      <div class="command-field">
        <span class="field-label">命令</span>
        <ToolMarkdownOutput :output="commandText" :command="commandText" />
      </div>
      <div v-if="!isRunning" class="command-meta">
        <span>工作目录：{{ details?.cwd || '等待执行' }}</span>
        <span>退出码：{{ exitCodeLabel }}</span>
        <span v-if="details?.signal">终止信号：{{ details.signal }}</span>
      </div>
      <section v-if="isRunning && streamingOutput" class="command-section streaming">
        <h4>实时输出</h4>
        <div ref="streamingOutputRef" class="streaming-output-scroll">
          <ToolMarkdownOutput :output="streamingOutput" :command="commandText" :is-streaming="true" />
        </div>
      </section>
      <section v-if="!isRunning" class="command-section">
        <h4>标准输出</h4>
        <ToolMarkdownOutput :output="stdoutPreview.text || '无输出'" :command="commandText" />
        <button
          v-if="stdoutPreview.hidden > 0"
          class="output-expand-btn"
          @click="stdoutExpanded = !stdoutExpanded"
        >
          {{ stdoutExpanded ? '收起' : `展开剩余 ${stdoutPreview.hidden} 行` }}
        </button>
      </section>
      <section v-if="!isRunning && details?.stderr" class="command-section">
        <h4>错误输出</h4>
        <ToolMarkdownOutput :output="stderrPreview.text" :command="commandText" />
        <button
          v-if="stderrPreview.hidden > 0"
          class="output-expand-btn"
          @click="stderrExpanded = !stderrExpanded"
        >
          {{ stderrExpanded ? '收起' : `展开剩余 ${stderrPreview.hidden} 行` }}
        </button>
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

.command-breathe-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-accent);
  animation: command-breathe 1.4s ease-in-out infinite;
}

@keyframes command-breathe {
  0%, 100% {
    opacity: 0.4;
    transform: scale(0.8);
    box-shadow: 0 0 2px 0 color-mix(in srgb, var(--color-accent) 30%, transparent);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
    box-shadow: 0 0 8px 2px color-mix(in srgb, var(--color-accent) 60%, transparent);
  }
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
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
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

.streaming-output-scroll {
  max-height: 300px;
  overflow-y: auto;
}

.output-expand-btn {
  display: block;
  width: 100%;
  margin-top: 2px;
  padding: 3px 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 10px;
  cursor: pointer;
  text-align: center;
  border-top: 1px solid var(--border-color);
}

.output-expand-btn:hover {
  color: var(--color-accent);
}
</style>
