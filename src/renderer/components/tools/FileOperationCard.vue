<script setup lang="ts">
import { computed } from 'vue';
import type { ToolCallContent } from '@shared/types';
import { fileOperationView } from '../../utils/tool-presentation';
import DiffViewer from '../code/DiffViewer.vue';

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
  return d?.type === 'file_edit' && d.status === 'edited'
    && (d as Record<string, unknown>).oldContent !== undefined
    && (d as Record<string, unknown>).newContent !== undefined;
});

const oldCode = computed(
  () => ((props.call.result?.details as Record<string, unknown>)?.oldContent as string) ?? '',
);
const newCode = computed(
  () => ((props.call.result?.details as Record<string, unknown>)?.newContent as string) ?? '',
);

const isEditing = computed(() => view.value.label === '编辑中');
</script>

<template>
  <!-- Editing: show diff inline -->
  <div v-if="isEditing" class="file-operation" :class="statusClass">
    <span class="file-icon">▤</span>
    <span class="file-path" :title="view.filePath">{{ view.filePath }}</span>
    <span class="file-status">{{ view.label }}</span>
    <span v-if="view.addedLines !== undefined" class="added">+{{ view.addedLines }}</span>
    <span v-if="view.removedLines !== undefined" class="removed">-{{ view.removedLines }}</span>
    <p v-if="view.error" class="file-error">{{ view.error }}</p>
    <DiffViewer
      v-if="showDiff"
      :old-code="oldCode"
      :new-code="newCode"
      :filename="view.filePath"
    />
  </div>

  <!-- Done: collapsible summary line, click to expand diff -->
  <details v-else class="file-operation-details" :class="statusClass">
    <summary class="file-summary">
      <span class="file-icon">▤</span>
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
.file-operation {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-md);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  font-size: 12px;
  flex-wrap: wrap;
  transition: border-color 0.15s ease;
}

.file-icon {
  flex-shrink: 0;
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

.status-edited .file-status {
  color: var(--color-green);
}

.status-failed {
  border-color: rgba(243, 139, 168, 0.3);
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

.file-error {
  width: 100%;
  margin: 0;
  font-size: 11px;
  color: var(--color-red);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Collapsible done-state card */
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
