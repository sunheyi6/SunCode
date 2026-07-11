<script setup lang="ts">
import type { MemoryEntry } from '@shared/types';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';

withDefaults(
  defineProps<{
    memory: MemoryEntry;
    compact?: boolean;
  }>(),
  {
    compact: false,
  },
);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const emit = defineEmits<{
  click: [];
}>();

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const kindLabels: Record<string, string> = {
  task_summary: '任务摘要',
  project_fact: '项目事实',
  decision: '决策',
  preference: '偏好',
  lesson: '经验教训',
  ephemeral: '临时',
};

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const kindColors: Record<string, string> = {
  task_summary: 'var(--color-accent)',
  project_fact: 'var(--color-teal)',
  decision: 'var(--color-purple)',
  preference: 'var(--color-green)',
  lesson: 'var(--color-orange)',
  ephemeral: 'var(--color-text-muted)',
};
</script>

<template>
  <button
    class="memory-reference"
    :class="{ compact }"
    type="button"
    :title="`记忆：${memory.userRequest}`"
    @click="emit('click')"
  >
    <span class="memory-reference-icon" aria-hidden="true">
      <AppIcon name="brain" :size="compact ? 13 : 14" />
    </span>
    <span
      class="memory-kind"
      :style="{
        borderColor: kindColors[memory.kind || 'task_summary'],
        color: kindColors[memory.kind || 'task_summary'],
      }"
    >
      {{ kindLabels[memory.kind || 'task_summary'] }}
    </span>
    <span class="memory-title">{{ memory.userRequest }}</span>
    <span class="memory-date">{{ memory.date }}</span>
    <AppIcon class="memory-reference-arrow" name="chevron-right" :size="13" />
  </button>
</template>

<style scoped>
.memory-reference {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 9px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  text-align: left;
  transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
}

.memory-reference.compact {
  padding: 9px 12px;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.memory-reference:hover {
  border-color: color-mix(in srgb, var(--color-accent) 52%, var(--border-color));
  background: color-mix(in srgb, var(--color-accent) 7%, var(--color-surface));
}

.memory-reference:active {
  transform: none;
}

.memory-reference-icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--color-accent);
}

.memory-kind {
  flex: 0 0 auto;
  padding: 2px 7px;
  border: 1px solid;
  border-radius: var(--border-radius-pill);
  font-size: 10px;
  font-weight: 650;
  line-height: 1.2;
}

.memory-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--color-text);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.memory-date {
  flex: 0 0 auto;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.memory-reference-arrow {
  flex: 0 0 auto;
  color: var(--color-text-muted);
}
</style>
