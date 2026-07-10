<script setup lang="ts">
import type { ToolExecution } from '../../stores/agent';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import ToolMarkdownOutput from './ToolMarkdownOutput.vue';

defineProps<{
  execution: ToolExecution;
}>();
</script>

<template>
  <div class="tool-card" :class="execution.status">
    <div class="tool-header">
      <span v-if="execution.status === 'running'" class="tool-breathe-dot" />
      <span class="tool-icon">
        <AppIcon
          :name="execution.status === 'running' ? 'loader' : execution.status === 'done' ? 'check-circle' : 'x'"
          :size="14"
        />
      </span>
      <span class="tool-name">{{ execution.toolName }}</span>
      <span class="tool-duration">
        {{ ((Date.now() - execution.startTime) / 1000).toFixed(1) }}s
      </span>
    </div>
    <div v-if="execution.result && execution.status !== 'running'" class="tool-output">
      <ToolMarkdownOutput :output="execution.result.output || execution.result.error || ''" />
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

.tool-breathe-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-teal);
  animation: tool-breathe 1.4s ease-in-out infinite;
}

@keyframes tool-breathe {
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
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

</style>
