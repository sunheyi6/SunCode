<script setup lang="ts">
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
    <pre class="grep-content"><code>{{ matches }}</code></pre>
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
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.4;
  font-family: var(--font-mono);
  background: var(--color-bg-tertiary);
  white-space: pre-wrap;
  max-height: 400px;
  overflow-y: auto;
  border-radius: 0;
  border: none;
}
</style>
