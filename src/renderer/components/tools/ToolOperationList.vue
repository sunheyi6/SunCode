<script setup lang="ts">
import type { ToolCallContent } from '@shared/types';
import CommandOperationCard from './CommandOperationCard.vue';
import FileInspectCard from './FileInspectCard.vue';
import FileOperationCard from './FileOperationCard.vue';
import SubagentCard from './SubagentCard.vue';

defineProps<{
  calls: ToolCallContent[];
}>();

function isInspectTool(name: string): boolean {
  return name === 'read' || name === 'glob' || name === 'grep';
}
</script>

<template>
  <div class="tool-operation-list">
    <template v-for="call in calls" :key="call.id">
      <SubagentCard v-if="call.name === 'subagent'" :call="call" />
      <FileOperationCard v-else-if="call.name === 'edit' || call.name === 'write'" :call="call" />
      <CommandOperationCard v-else-if="call.name === 'bash'" :call="call" />
      <FileInspectCard v-else-if="isInspectTool(call.name)" :call="call" />
      <div v-else class="generic-tool" :class="{ 'generic-running': call.status === 'running' }">
        <span v-if="call.status === 'running'" class="generic-breathe-dot" />
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

.generic-running {
  border-color: var(--color-accent);
}

.generic-running .generic-status {
  color: var(--color-accent);
}

.generic-breathe-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-accent);
  animation: generic-breathe 1.4s ease-in-out infinite;
}

@keyframes generic-breathe {
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
</style>
