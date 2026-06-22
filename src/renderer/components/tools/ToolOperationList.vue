<script setup lang="ts">
import type { ToolCallContent } from '@shared/types';
import CommandOperationCard from './CommandOperationCard.vue';
import FileOperationCard from './FileOperationCard.vue';

defineProps<{
  calls: ToolCallContent[];
}>();
</script>

<template>
  <div class="tool-operation-list">
    <template v-for="call in calls" :key="call.id">
      <FileOperationCard v-if="call.name === 'edit' || call.name === 'write'" :call="call" />
      <CommandOperationCard v-else-if="call.name === 'bash'" :call="call" />
      <div v-else class="generic-tool">
        <span class="generic-name">{{ call.name }}</span>
        <span class="generic-status">
          {{ call.status === 'running' ? '执行中' : call.status === 'error' ? '执行失败' : '已执行' }}
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tool-operation-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  margin-top: var(--spacing-sm);
}

.generic-tool {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-md);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  font-size: 12px;
}

.generic-name {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-secondary);
}

.generic-status {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-left: auto;
}
</style>
