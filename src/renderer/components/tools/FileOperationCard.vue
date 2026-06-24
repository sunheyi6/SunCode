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
  return d?.type === 'file_edit' && d.status === 'edited' && d.oldContent && d.newContent;
});

const oldCode = computed(() => (props.call.result?.details as Record<string, unknown>)?.oldContent as string ?? '');
const newCode = computed(() => (props.call.result?.details as Record<string, unknown>)?.newContent as string ?? '');
</script>

<template>
  <div class="file-operation" :class="statusClass">
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
</style>
