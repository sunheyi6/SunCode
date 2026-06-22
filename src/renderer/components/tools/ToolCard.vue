<script setup lang="ts">
import type { ToolExecution } from '../../stores/agent';

defineProps<{
  execution: ToolExecution;
}>();
</script>

<template>
  <div class="tool-card" :class="execution.status">
    <div class="tool-header">
      <span class="tool-icon">
        {{ execution.status === 'running' ? '⏳' : execution.status === 'done' ? '✅' : '❌' }}
      </span>
      <span class="tool-name">{{ execution.toolName }}</span>
      <span class="tool-duration">
        {{ ((Date.now() - execution.startTime) / 1000).toFixed(1) }}s
      </span>
    </div>
    <div v-if="execution.result && execution.status !== 'running'" class="tool-output">
      <pre>{{ execution.result.output || execution.result.error }}</pre>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  margin: 6px 0;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  overflow: hidden;
  font-size: 13px;
}

.tool-card.running {
  border-color: var(--color-teal);
}

.tool-card.done {
  border-color: var(--color-green);
}

.tool-card.error {
  border-color: var(--color-red);
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--color-surface);
}

.tool-icon {
  font-size: 12px;
}

.tool-name {
  font-weight: 500;
  color: var(--color-text);
  flex: 1;
}

.tool-duration {
  font-size: 11px;
  color: var(--color-text-muted);
}

.tool-output {
  padding: 8px 10px;
  background: var(--color-bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.tool-output pre {
  margin: 0;
  padding: 0;
  font-size: 12px;
  font-family: var(--font-mono);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
  background: transparent;
  border: none;
}
</style>
