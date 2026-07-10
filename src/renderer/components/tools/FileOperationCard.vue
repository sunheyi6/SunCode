<script setup lang="ts">
import type { ToolCallContent } from '@shared/types';
import { computed } from 'vue';
import { fileOperationView } from '../../utils/tool-presentation';
import DiffViewer from '../code/DiffViewer.vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';

const props = defineProps<{
  call: ToolCallContent;
}>();

const view = computed(() => fileOperationView(props.call));

const statusClass = computed(() => {
  if (view.value.label === '编辑中') return 'status-editing';
  if (view.value.label === '编辑失败') return 'status-failed';
  return 'status-edited';
});

const showDiff = computed(() => {
  const d = props.call.result?.details;
  // oldContent/newContent may be '' for new files — check !== undefined
  return (
    d?.type === 'file_edit' &&
    d.status === 'edited' &&
    (d as unknown as Record<string, unknown>).oldContent !== undefined &&
    (d as unknown as Record<string, unknown>).newContent !== undefined
  );
});

const oldCode = computed(
  () =>
    ((props.call.result?.details as unknown as Record<string, unknown>)?.oldContent as string) ??
    '',
);
const newCode = computed(
  () =>
    ((props.call.result?.details as unknown as Record<string, unknown>)?.newContent as string) ??
    '',
);

const isEditing = computed(() => view.value.label === '编辑中');
</script>

<template>
  <details class="file-operation-details" :class="statusClass">
    <summary class="file-summary">
      <span class="file-icon"><AppIcon name="file" :size="13" /></span>
      <span v-if="isEditing" class="file-breathe-dot" />
      <span class="file-path" :title="view.filePath">{{ view.filePath }}</span>
      <span class="file-status">{{ view.label }}</span>
      <span v-if="view.addedLines !== undefined" class="added">+{{ view.addedLines }}</span>
      <span v-if="view.removedLines !== undefined" class="removed">-{{ view.removedLines }}</span>
      <span v-if="showDiff" class="expand-hint">展开</span>
    </summary>
    <p v-if="view.error" class="file-error">{{ view.error }}</p>
    <DiffViewer
      v-if="showDiff"
      :old-code="oldCode"
      :new-code="newCode"
      :filename="view.filePath"
    />
  </details>
</template>

<style scoped>
.file-operation-details {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  font-size: 12px;
  transition: border-color 0.15s ease;
}

.file-operation-details .file-error {
  margin: 4px 8px;
}

.file-summary {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-md);
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.file-summary::-webkit-details-marker {
  display: none;
}

.file-icon {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

.file-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-secondary);
}

.file-status {
  flex-shrink: 0;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
}

.status-editing .file-status {
  color: var(--color-teal);
}

.file-breathe-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-teal);
  animation: file-breathe 1.4s ease-in-out infinite;
}

@keyframes file-breathe {
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

.status-edited .file-status {
  color: var(--color-green);
}

.status-failed .file-status {
  color: var(--color-red);
}

.added {
  flex-shrink: 0;
  color: var(--color-green);
  font-family: var(--font-mono);
  font-size: 11px;
}

.removed {
  flex-shrink: 0;
  color: var(--color-red);
  font-family: var(--font-mono);
  font-size: 11px;
}

.expand-hint {
  font-size: 10px;
  color: var(--color-text-muted);
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.12s;
}

.file-summary:hover .expand-hint {
  opacity: 1;
}

.file-operation-details[open] .expand-hint {
  display: none;
}

.file-operation-details.status-failed {
  border-color: rgba(243, 139, 168, 0.3);
}
</style>
