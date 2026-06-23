<script setup lang="ts">
import { computed } from 'vue';
import type { ToolCallContent } from '@shared/types';
import { parseToolArguments } from '../../utils/tool-presentation';

const props = defineProps<{
  call: ToolCallContent;
}>();

const args = computed(() => parseToolArguments(props.call.arguments));

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

const target = computed(() => {
  const filePath = args.value.file_path as string;
  const pattern = args.value.pattern as string;
  return filePath || pattern || '';
});

const outputPreview = computed(() => {
  const output = props.call.result?.output;
  if (!output) return null;
  // Truncate for preview
  return output.length > 300 ? `${output.slice(0, 300)}...` : output;
});

const isFailed = computed(
  () => props.call.status === 'error' || props.call.result?.success === false,
);
</script>

<template>
  <details class="file-inspect" :class="{ 'inspect-failed': isFailed }">
    <summary class="inspect-summary">
      <span class="inspect-icon">{{ isFailed ? '✗' : '▤' }}</span>
      <span class="inspect-label">{{ label }}</span>
      <span class="inspect-path" :title="target">{{ target || '等待参数...' }}</span>
      <span class="inspect-status">{{ isFailed ? '失败' : '完成' }}</span>
    </summary>
    <div class="inspect-body">
      <div class="inspect-output" v-if="outputPreview">
        <pre>{{ outputPreview }}</pre>
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

.inspect-failed {
  border-color: rgba(243, 139, 168, 0.3);
}

.inspect-summary {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-md);
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.inspect-summary::-webkit-details-marker {
  display: none;
}

.inspect-icon {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: 11px;
}

.inspect-label {
  flex-shrink: 0;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--color-teal);
}

.inspect-failed .inspect-label {
  color: var(--color-red);
}

.inspect-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-secondary);
}

.inspect-status {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-green);
}

.inspect-failed .inspect-status {
  color: var(--color-red);
}

.inspect-body {
  padding: var(--spacing-xs) var(--spacing-md) var(--spacing-md);
  border-top: 1px solid var(--border-color);
}

.inspect-output pre {
  margin: 0;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--color-bg-secondary);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
}

.inspect-empty {
  font-size: 11px;
  color: var(--color-text-muted);
}
</style>
