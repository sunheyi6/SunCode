<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  code: string;
  language?: string;
  filename?: string;
}>();

const codeRef = ref<HTMLElement | null>(null);
let editorInstance: { destroy: () => void } | null = null;

const copied = ref(false);

async function copyCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // Clipboard might not be available
  }
}

// Simple syntax-highlighted code block (without CodeMirror dependency at runtime)
// For full CodeMirror, we use a simpler pre-based approach for now
</script>

<template>
  <div class="code-block-wrapper">
    <div class="code-block-header">
      <span class="code-lang">{{ language || 'code' }}</span>
      <span v-if="filename" class="code-filename">{{ filename }}</span>
      <button class="copy-btn" @click="copyCode">
        {{ copied ? '✓ 已复制' : '复制' }}
      </button>
    </div>
    <pre class="code-block"><code :class="language ? `language-${language}` : ''">{{ code }}</code></pre>
  </div>
</template>

<style scoped>
.code-block-wrapper {
  margin: var(--spacing-sm) 0;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  overflow: hidden;
}

.code-block-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--color-surface);
  border-bottom: 1px solid var(--border-color);
}

.code-lang {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-accent);
  text-transform: uppercase;
}

.code-filename {
  font-size: 12px;
  color: var(--color-text-secondary);
  flex: 1;
}

.copy-btn {
  font-size: 11px;
  padding: 2px 8px;
  background: transparent;
  color: var(--color-text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  cursor: pointer;
}

.copy-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.code-block {
  margin: 0;
  padding: 12px;
  background: var(--color-bg-tertiary);
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
  border-radius: 0;
}

.code-block code {
  background: none;
  padding: 0;
  font-family: var(--font-mono);
}
</style>
