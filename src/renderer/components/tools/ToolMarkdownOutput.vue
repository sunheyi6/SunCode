<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import MarkdownRender from 'markstream-vue';
import 'markstream-vue/index.css';
import { computed } from 'vue';
import { useSettingsStore } from '../../stores/settings';
import { formatToolOutputAsMarkdown } from '../../utils/tool-presentation';

const props = withDefaults(
  defineProps<{
    output: string;
    command?: string;
    isStreaming?: boolean;
  }>(),
  {
    command: undefined,
    isStreaming: false,
  },
);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const markdown = computed(() => formatToolOutputAsMarkdown(props.command, props.output));

const settingsStore = useSettingsStore();
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const isDark = computed(() => settingsStore.resolvedTheme === 'dark');
</script>

<template>
  <div class="tool-markdown-output" :class="{ streaming: isStreaming }">
    <MarkdownRender
      custom-id="tool-output"
      mode="chat"
      :content="markdown"
      :final="!isStreaming"
      :smooth-streaming="isStreaming ? 'auto' : false"
      :fade="false"
      :typewriter="false"
      :max-live-nodes="0"
      code-renderer="shiki"
      :is-dark="isDark"
      :code-block-props="{ showLineNumbers: true, theme: { light: 'material-theme-lighter', dark: 'material-theme' } }"
    />
  </div>
</template>

<style scoped>
.tool-markdown-output {
  min-width: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.tool-markdown-output :deep([data-custom-id="tool-output"]) {
  color: inherit;
  font: inherit;
}

.tool-markdown-output :deep(pre) {
  margin: 0;
  max-height: 300px;
  overflow: auto;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--border-color);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-markdown-output.streaming :deep(pre) {
  border-color: color-mix(in srgb, var(--color-accent) 20%, transparent);
}
</style>
