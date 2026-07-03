<script setup lang="ts">
import type { ToolCallContent } from '@shared/types';
import { computed, ref } from 'vue';
import { parseToolArguments } from '../../utils/tool-presentation';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import ToolMarkdownOutput from './ToolMarkdownOutput.vue';

const props = defineProps<{
  call: ToolCallContent;
}>();

const args = computed(() => parseToolArguments(props.call.arguments));

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const label = computed(() => {
  switch (props.call.name) {
    case 'read':
      return '读取';
    case 'glob':
      return '查找';
    case 'grep':
      return '搜索';
    default:
      return props.call.name;
  }
});

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const target = computed(() => {
  const fp = args.value.file_path as string;
  const pat = args.value.pattern as string;
  return fp || pat || '';
});

// Args entries (non-sensitive fields only)
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const argsEntries = computed(() => {
  const e: Array<{ key: string; value: string }> = [];
  const skip = new Set(['file_path', 'pattern', 'content', 'text', 'old_string', 'new_string']);
  for (const [k, v] of Object.entries(args.value)) {
    if (skip.has(k)) continue;
    if (v === undefined || v === null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    e.push({ key: k, value: s.length > 100 ? `${s.slice(0, 97)}...` : s });
  }
  return e;
});

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const showArgs = ref(false);

// ── Expandable output ──
const OUTPUT_PREVIEW_LINES = 5;
const outputExpanded = ref(false);
const outputText = computed(() => props.call.result?.output ?? '');

const outputLines = computed(() => outputText.value.split('\n'));

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const outputPreview = computed(() => {
  if (outputExpanded.value || outputLines.value.length <= OUTPUT_PREVIEW_LINES) {
    return outputText.value;
  }
  return outputLines.value.slice(0, OUTPUT_PREVIEW_LINES).join('\n');
});

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const outputHiddenLines = computed(() => {
  if (outputLines.value.length <= OUTPUT_PREVIEW_LINES) return 0;
  return outputLines.value.length - OUTPUT_PREVIEW_LINES;
});

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const isFailed = computed(
  () => props.call.status === 'error' || props.call.result?.success === false,
);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const isRunning = computed(() => props.call.status === 'running');
</script>

<template>
  <details class="file-inspect" :class="{ 'inspect-failed': isFailed, 'inspect-running': isRunning }">
    <summary class="inspect-summary">
      <span class="inspect-icon">{{ isFailed ? '✗' : '▤' }}</span>
      <span v-if="isRunning" class="inspect-breathe-dot" />
      <span class="inspect-label">{{ label }}</span>
      <span class="inspect-path" :title="target">{{ target || '等待参数...' }}</span>
      <span class="inspect-status">{{ isFailed ? '失败' : isRunning ? '执行中' : '完成' }}</span>
    </summary>
    <div class="inspect-body">
      <!-- Args (collapsed toggle) -->
      <div v-if="argsEntries.length > 0" class="inspect-args">
        <button class="args-toggle" @click="showArgs = !showArgs">
          {{ showArgs ? '▼' : '▶' }} 参数 ({{ argsEntries.length }})
        </button>
        <div v-if="showArgs" class="args-list">
          <div v-for="e in argsEntries" :key="e.key" class="args-row">
            <span class="args-key">{{ e.key }}</span>
            <code class="args-val">{{ e.value }}</code>
          </div>
        </div>
      </div>

      <!-- Output (Markdown-rendered fenced code block) -->
      <div v-if="outputText" class="inspect-output">
        <div class="output-label">输出 ({{ outputLines.length }} 行 · {{ outputText.length }} 字符)</div>
        <ToolMarkdownOutput :output="outputPreview" :command="target" />
        <button
          v-if="outputHiddenLines > 0"
          class="output-expand-btn"
          @click="outputExpanded = !outputExpanded"
        >
          {{ outputExpanded ? '收起' : `展开剩余 ${outputHiddenLines} 行` }}
        </button>
      </div>
      <div class="inspect-output inspect-empty" v-else-if="!props.call.result">
        <em>执行中...</em>
      </div>
      <div class="inspect-output inspect-empty" v-else>
        <em>无输出</em>
      </div>
    </div>
  </details>
</template>

<style scoped>
.file-inspect {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  font-size: 12px;
  overflow: hidden;
}
.inspect-failed { border-color: rgba(243, 139, 168, 0.3); }
.inspect-running { border-color: var(--color-teal); }

.inspect-summary {
  display: flex; align-items: center; gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-md);
  cursor: pointer; user-select: none; list-style: none;
}
.inspect-summary::-webkit-details-marker { display: none; }

.inspect-icon { flex-shrink: 0; color: var(--color-text-muted); font-size: 11px; }

.inspect-label {
  flex-shrink: 0; font-size: 11px; padding: 1px 6px;
  border-radius: 4px; color: var(--color-teal);
}
.inspect-failed .inspect-label { color: var(--color-red); }

.inspect-path {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex: 1; font-family: var(--font-mono); font-size: 11px; color: var(--color-text-secondary);
}

.inspect-status { flex-shrink: 0; font-size: 11px; color: var(--color-green); }
.inspect-failed .inspect-status { color: var(--color-red); }

.inspect-breathe-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-teal);
  animation: inspect-breathe 1.4s ease-in-out infinite;
}

@keyframes inspect-breathe {
  0%, 100% {
    opacity: 0.4;
    transform: scale(0.8);
    box-shadow: 0 0 2px 0 color-mix(in srgb, var(--color-teal) 30%, transparent);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
    box-shadow: 0 0 8px 2px color-mix(in srgb, var(--color-teal) 60%, transparent);
  }
}

.inspect-body {
  padding: var(--spacing-xs) var(--spacing-md) var(--spacing-md);
  border-top: 1px solid var(--border-color);
}

/* ── Args ── */
.inspect-args { margin-bottom: 6px; }

.args-toggle {
  display: inline-flex; align-items: center; gap: 4px;
  border: none; background: transparent; color: var(--color-text-muted);
  font-size: 10px; cursor: pointer; padding: 2px 0;
}
.args-toggle:hover { color: var(--color-text-secondary); }

.args-list { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; padding-left: 4px; }
.args-row { display: flex; gap: 6px; align-items: baseline; }

.args-key {
  font-size: 10px; color: var(--color-text-muted);
  font-family: var(--font-mono); flex-shrink: 0;
}
.args-val {
  font-size: 10px; color: var(--color-text-secondary);
  font-family: var(--font-mono); word-break: break-all;
  background: var(--color-bg-secondary); padding: 0 4px; border-radius: 2px;
}

/* ── Output ── */
.inspect-output { margin-top: 4px; }

.output-label {
  font-size: 10px; color: var(--color-text-muted);
  margin-bottom: 2px; font-weight: 500;
}

.output-expand-btn {
  display: block; width: 100%; margin-top: 4px; padding: 4px 0;
  border: none; background: transparent; color: var(--color-text-muted);
  font-size: 11px; cursor: pointer; text-align: center;
  border-top: 1px solid var(--border-color);
}
.output-expand-btn:hover { color: var(--color-accent); }

.inspect-empty { font-size: 11px; color: var(--color-text-muted); }
</style>
