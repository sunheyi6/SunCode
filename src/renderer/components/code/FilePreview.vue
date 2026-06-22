<script setup lang="ts">
import { computed } from 'vue';
import CodeBlock from './CodeBlock.vue';

const props = defineProps<{
  filename: string;
  content: string;
  language?: string;
}>();

const language = computed(() => {
  if (props.language) return props.language;

  const ext = props.filename.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    vue: 'html',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    rb: 'ruby',
    css: 'css',
    html: 'html',
    json: 'json',
    md: 'markdown',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
  };

  return langMap[ext || ''] || '';
});
</script>

<template>
  <div class="file-preview">
    <CodeBlock :code="content" :language="language" :filename="filename" />
  </div>
</template>

<style scoped>
.file-preview {
  padding: var(--spacing-md);
}
</style>
