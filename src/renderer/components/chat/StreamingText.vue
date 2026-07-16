<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import MarkdownRender from 'markstream-vue';
import 'markstream-vue/index.css';
import { computed } from 'vue';
import { useSettingsStore } from '../../stores/settings';
import { buildStreamingTextRenderOptions } from './streaming-text-renderer';

const props = defineProps<{
  text: string;
  isStreaming: boolean;
}>();

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const renderOptions = computed(() => buildStreamingTextRenderOptions(props.isStreaming));

const settingsStore = useSettingsStore();
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const isDark = computed(() => settingsStore.resolvedTheme === 'dark');

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const containerClass = computed(() => ({
  'streaming-text': true,
  'is-streaming': props.isStreaming,
}));
</script>

<template>
  <div :class="containerClass">
    <MarkdownRender
      custom-id="chat"
      mode="chat"
      :content="text"
      :final="renderOptions.final"
      :smooth-streaming="renderOptions.smoothStreaming"
      :fade="renderOptions.fade"
      :typewriter="renderOptions.typewriter"
      :max-live-nodes="renderOptions.maxLiveNodes"
      code-renderer="shiki"
      :is-dark="isDark"
      :code-block-props="{ showLineNumbers: true, theme: { light: 'material-theme-lighter', dark: 'material-theme' } }"
    />
  </div>
</template>

<style scoped>
.streaming-text {
  line-height: 1.6;
}

.streaming-text :deep([data-custom-id="chat"]) {
  color: inherit;
  font: inherit;
  --inline-code-fg: var(--color-accent);
  --inline-code-bg: color-mix(in srgb, var(--color-accent) 12%, transparent);
}

.streaming-text :deep(p) {
  margin: 0 0 8px 0;
}

.streaming-text :deep(p:last-child) {
  margin-bottom: 0;
}

.streaming-text :deep(a) {
  color: var(--color-accent);
  text-decoration: none;
}

.streaming-text :deep(a:hover) {
  text-decoration: underline;
}

.streaming-text :deep(pre) {
  margin: 8px 0;
}

.streaming-text :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
}

.streaming-text :deep(blockquote) {
  border-left: 3px solid var(--color-accent);
  padding-left: 12px;
  margin: 8px 0;
  color: var(--color-text-secondary);
}

.streaming-text :deep(ul),
.streaming-text :deep(ol) {
  padding-left: 20px;
  margin: 4px 0;
}

.streaming-text :deep(li) {
  margin: 2px 0;
}

.streaming-text :deep(h1),
.streaming-text :deep(h2),
.streaming-text :deep(h3) {
  margin: 12px 0 8px 0;
  font-weight: 600;
}

.streaming-text :deep(h1) {
  font-size: 1.4em;
}

.streaming-text :deep(h2) {
  font-size: 1.2em;
}

.streaming-text :deep(h3) {
  font-size: 1.1em;
}

.streaming-text :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0 12px 0;
  font-size: 13px;
}

.streaming-text :deep(th),
.streaming-text :deep(td) {
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  text-align: left;
  vertical-align: top;
}

.streaming-text :deep(th) {
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.streaming-text :deep(tr:nth-child(even) td) {
  background: color-mix(in srgb, var(--color-surface) 40%, transparent);
}

.streaming-text :deep(tr:hover td) {
  background: color-mix(in srgb, var(--color-accent) 6%, transparent);
}

.streaming-text :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border-color);
  margin: 16px 0;
}
</style>
