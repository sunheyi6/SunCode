<script setup lang="ts">
import { computed } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const props = defineProps<{
  text: string;
  isStreaming: boolean;
}>();

const renderedHtml = computed(() => {
  if (!props.text) return '';

  // Configure marked for code rendering
  const html = marked.parse(props.text, { async: false }) as string;

  // Sanitize HTML
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 's', 'a', 'code', 'pre',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'blockquote',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'span', 'div', 'details', 'summary',
    ],
    ALLOWED_ATTR: ['href', 'target', 'class', 'rel'],
  });
});

// Add cursor blink when streaming
const containerClass = computed(() => ({
  'streaming-text': true,
  'is-streaming': props.isStreaming,
}));
</script>

<template>
  <div :class="containerClass">
    <div class="markdown-content" v-html="renderedHtml" />
    <span v-if="isStreaming" class="cursor-blink">▌</span>
  </div>
</template>

<style scoped>
.streaming-text {
  line-height: 1.6;
}

.markdown-content :deep(p) {
  margin: 0 0 8px 0;
}

.markdown-content :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-content :deep(a) {
  color: var(--color-accent);
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

.markdown-content :deep(pre) {
  margin: 8px 0;
}

.markdown-content :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
}

.markdown-content :deep(blockquote) {
  border-left: 3px solid var(--color-accent);
  padding-left: 12px;
  margin: 8px 0;
  color: var(--color-text-secondary);
}

.markdown-content :deep(ul), .markdown-content :deep(ol) {
  padding-left: 20px;
  margin: 4px 0;
}

.markdown-content :deep(li) {
  margin: 2px 0;
}

.markdown-content :deep(h1), .markdown-content :deep(h2), .markdown-content :deep(h3) {
  margin: 12px 0 8px 0;
  font-weight: 600;
}

.markdown-content :deep(h1) { font-size: 1.4em; }
.markdown-content :deep(h2) { font-size: 1.2em; }
.markdown-content :deep(h3) { font-size: 1.1em; }

/* ---- tables ---- */
.markdown-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0 12px 0;
  font-size: 13px;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  text-align: left;
  vertical-align: top;
}

.markdown-content :deep(th) {
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.markdown-content :deep(tr:nth-child(even) td) {
  background: color-mix(in srgb, var(--color-surface) 40%, transparent);
}

.markdown-content :deep(tr:hover td) {
  background: color-mix(in srgb, var(--color-accent) 6%, transparent);
}

/* ---- horizontal rule ---- */
.markdown-content :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border-color);
  margin: 16px 0;
}

.cursor-blink {
  color: var(--color-accent);
  animation: blink 1s step-end infinite;
  font-weight: 100;
}

@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}
</style>
