<script setup lang="ts">
defineProps<{
  output: string;
  exitCode?: number;
}>();
</script>

<template>
  <div class="bash-output">
    <div class="bash-header">
      <span class="bash-label">终端输出</span>
      <span v-if="exitCode !== undefined" class="bash-exit" :class="{ error: exitCode !== 0 }">
        退出码: {{ exitCode }}
      </span>
    </div>
    <pre class="bash-content"><code>{{ output }}</code></pre>
  </div>
</template>

<style scoped>
.bash-output {
  margin: 6px 0;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  overflow: hidden;
  font-size: 13px;
}

.bash-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: var(--color-bg-tertiary);
  border-bottom: 1px solid var(--border-color);
}

.bash-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
}

.bash-exit {
  font-size: 11px;
  color: var(--color-green);
}

.bash-exit.error {
  color: var(--color-red);
}

.bash-content {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.4;
  font-family: var(--font-mono);
  background: var(--color-bg-tertiary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 400px;
  overflow-y: auto;
  border-radius: 0;
  border: none;
}
</style>
