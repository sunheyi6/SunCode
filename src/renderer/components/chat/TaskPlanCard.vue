<script setup lang="ts">
import { computed } from 'vue';
import type { TaskPlan } from '@shared/types';

const props = defineProps<{
  taskPlan: TaskPlan;
  isStreaming: boolean;
}>();

const totalCount = computed(() => props.taskPlan.steps.length);
const doneCount = computed(() => props.taskPlan.steps.filter((s) => s.status === 'done').length);
const allDone = computed(() => doneCount.value === totalCount.value);

function stepIcon(status: string): string {
  if (status === 'done') return '✓';
  if (status === 'in_progress') return '◉';
  return '○';
}
</script>

<template>
  <div class="task-plan-card" :class="{ 'all-done': allDone && !isStreaming }">
    <!-- Header -->
    <div class="plan-header">
      <span class="plan-badge">
        {{ isStreaming ? '🔄' : allDone ? '✅' : '📋' }}
        {{ taskPlan.taskType === 'execution' ? '执行计划' : '查询' }}
      </span>
      <span class="plan-progress">
        <template v-if="isStreaming">执行中 · {{ doneCount }}/{{ totalCount }}</template>
        <template v-else-if="allDone">全部完成</template>
        <template v-else>{{ doneCount }}/{{ totalCount }} 完成</template>
      </span>
    </div>

    <!-- Step list -->
    <div class="plan-steps">
      <div
        v-for="step in taskPlan.steps"
        :key="step.id"
        class="plan-step"
        :class="`step-${step.status}`"
      >
        <span class="step-icon" :class="`icon-${step.status}`">
          {{ stepIcon(step.status) }}
        </span>
        <span class="step-desc">{{ step.description }}</span>
        <span v-if="step.result" class="step-result">{{ step.result }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-plan-card {
  margin-bottom: var(--spacing-sm);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  overflow: hidden;
  background: var(--color-bg-tertiary);
  transition: border-color 0.3s;
}

.task-plan-card.all-done {
  border-color: color-mix(in srgb, var(--color-green, #4caf50) 40%, transparent);
}

/* Header */
.plan-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--color-surface);
  border-bottom: 1px solid var(--border-color);
}

.plan-badge {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
}

.plan-progress {
  font-size: 11px;
  color: var(--color-text-muted);
}

.all-done .plan-progress {
  color: var(--color-green, #4caf50);
}

/* Steps */
.plan-steps {
  padding: 4px 10px 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.plan-step {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 3px;
  font-size: 12px;
  line-height: 1.4;
  transition: background 0.15s;
}

/* Status colors */
.step-pending {
  color: var(--color-text-muted);
}

.step-in_progress {
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
  color: var(--color-text);
}

.step-done {
  color: var(--color-text-secondary);
}

/* Icons */
.step-icon {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-size: 12px;
}

.icon-pending {
  color: var(--color-text-muted);
  opacity: 0.5;
}

.icon-in_progress {
  color: var(--color-accent, #6c8cff);
  animation: plan-pulse 1.4s ease-in-out infinite;
}

.icon-done {
  color: var(--color-green, #4caf50);
}

@keyframes plan-pulse {
  0%, 100% { opacity: 0.5; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.1); }
}

.step-desc {
  flex: 1;
  min-width: 0;
}

.step-done .step-desc {
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--color-text-muted) 30%, transparent);
}

.step-result {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-text-muted);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
