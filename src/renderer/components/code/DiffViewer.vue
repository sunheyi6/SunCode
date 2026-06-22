<script setup lang="ts">
defineProps<{
  oldCode: string;
  newCode: string;
  filename?: string;
}>();

/**
 * Simple diff viewer that shows old and new code side by side.
 * For a full implementation, integrate CodeMirror's merge extension.
 */
</script>

<template>
  <div class="diff-viewer">
    <div class="diff-header">
      <span class="diff-filename">{{ filename || '文件' }}</span>
      <span class="diff-label old">原始</span>
      <span class="diff-label new">修改后</span>
    </div>
    <div class="diff-panes">
      <div class="diff-pane old">
        <pre class="diff-content"><code>{{ oldCode }}</code></pre>
      </div>
      <div class="diff-divider" />
      <div class="diff-pane new">
        <pre class="diff-content"><code>{{ newCode }}</code></pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-viewer {
  margin: var(--spacing-sm) 0;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  overflow: hidden;
}

.diff-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: var(--color-surface);
  border-bottom: 1px solid var(--border-color);
}

.diff-filename {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
  flex: 1;
}

.diff-label {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 3px;
}

.diff-label.old {
  background: var(--color-red);
  color: var(--color-bg);
  opacity: 0.8;
}

.diff-label.new {
  background: var(--color-green);
  color: var(--color-bg);
  opacity: 0.8;
}

.diff-panes {
  display: flex;
}

.diff-pane {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
}

.diff-pane.old {
  background: rgba(243, 139, 168, 0.05);
}

.diff-pane.new {
  background: rgba(166, 227, 161, 0.05);
}

.diff-divider {
  width: 1px;
  background: var(--border-color);
}

.diff-content {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.5;
  background: transparent;
  border: none;
  border-radius: 0;
}

.diff-content code {
  font-family: var(--font-mono);
}
</style>
