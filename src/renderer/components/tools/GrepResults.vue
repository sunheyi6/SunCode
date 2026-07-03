<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import ToolMarkdownOutput from './ToolMarkdownOutput.vue';

defineProps<{
  matches: string;
  count?: number;
}>();
</script>

<template>
  <div class="grep-results">
    <div class="grep-header">
      <span class="grep-label">搜索结果</span>
      <span v-if="count !== undefined" class="grep-count">{{ count }} matches</span>
    </div>
    <div class="grep-content">
      <ToolMarkdownOutput :output="matches" command="grep" />
    </div>
  </div>
</template>

<style scoped>
.grep-results {
  margin: 6px 0;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  overflow: hidden;
  font-size: 13px;
}

.grep-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--border-color);
}

.grep-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
}

.grep-count {
  font-size: 11px;
  color: var(--color-accent);
}

.grep-content {
  padding: 8px 12px;
  background: var(--color-bg-tertiary);
  max-height: 400px;
  overflow-y: auto;
}
</style>
