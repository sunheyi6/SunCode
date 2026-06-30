<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolCallContent } from '@shared/types';
import { parseToolArguments } from '../../utils/tool-presentation';
import CodeBlock from '../code/CodeBlock.vue';

const props = defineProps<{
  call: ToolCallContent;
}>();

const args = computed(() => parseToolArguments(props.call.arguments));

const label = computed(() => {
  switch (props.call.name) {
    case 'read':  return '读取';
    case 'glob':  return '查找';
    case 'grep':  return '搜索';
    default:      return props.call.name;
  }
});

const target = computed(() => {
  const fp = args.value.file_path as string;
  const pat = args.value.pattern as string;
  return fp || pat || '';
});

// Detect output language from tool + args
const outputLang = computed(() => {
  switch (props.call.name) {
    case 'read': {
      const fp = (args.value.file_path as string) || '';
      return detectLangFromPath(fp);
    }
    case 'grep': return 'text';
    case 'glob': return 'text';
    default:    return undefined;
  }
});

function detectLangFromPath(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    vue: 'html', html: 'html', css: 'css', scss: 'scss', less: 'less',
    py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
    h: 'c', hpp: 'cpp', json: 'json', yaml: 'yaml', yml: 'yaml',
    xml: 'xml', md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
    ps1: 'powershell', bat: 'batch', cmd: 'batch',
    sql: 'sql', graphql: 'graphql', toml: 'toml', ini: 'ini', cfg: 'ini',
    Dockerfile: 'dockerfile', Makefile: 'makefile',
  };
  if (map[ext]) return map[ext];
  // Try the whole filename
  const base = filePath.split(/[/\\]/).pop()?.toLowerCase() || '';
  if (map[base]) return map[base];
  return undefined;
}

// Args entries (non-sensitive fields only)
const argsEntries = computed(() => {
  const e: Array<{ key: string; value: string }> = [];
  const skip = new Set(['file_path', 'pattern', 'content', 'text', 'old_string', 'new_string']);
  for (const [k, v] of Object.entries(args.value)) {
    if (skip.has(k)) continue;
    if (v === undefined || v === null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    e.push({ key: k, value: s.length > 100 ? s.slice(0, 97) + '...' : s });
  }
  return e;
});

const showArgs = ref(false);

// ── Expandable output ──
const OUTPUT_PREVIEW_LINES = 5;
const outputExpanded = ref(false);
const outputText = computed(() => props.call.result?.output ?? '');

const outputLines = computed(() => outputText.value.split('\n'));

const outputPreview = computed(() => {
  if (outputExpanded.value || outputLines.value.length <= OUTPUT_PREVIEW_LINES) {
    return outputText.value;
  }
  return outputLines.value.slice(0, OUTPUT_PREVIEW_LINES).join('\n');
});

const outputHiddenLines = computed(() => {
  if (outputLines.value.length <= OUTPUT_PREVIEW_LINES) return 0;
  return outputLines.value.length - OUTPUT_PREVIEW_LINES;
});

const isFailed = computed(
  () => props.call.status === 'error' || props.call.result?.success === false,
);
</script>

<template>
  <details class="file-inspect" :class="{ 'inspect-failed': isFailed }">
    <summary class="inspect-summary">
      <span class="inspect-icon">{{ isFailed ? '✗' : '▤' }}</span>
      <span class="inspect-label">{{ label }}</span>
      <span class="inspect-path" :title="target">{{ target || '等待参数...' }}</span>
      <span class="inspect-status">{{ isFailed ? '失败' : '完成' }}</span>
    </summary>
    <div class="inspect-body">
      <!-- Args (collapsed toggle) -->
      <div v-if="argsEntries.length > 0" class="inspect-args">
        <button class="args-toggle" @click="showArgs = !showArgs">
          {{ showArgs ? '▼' : '▶' }} 参数 ({{ argsEntries.length }})
        </button>
        <div v-if="showArgs" class="args-list">
          <div v-for="e in argsEntries" :key="e.key" class="args-row">
            <span class="args-key">{{ e.key }}</span>
            <code class="args-val">{{ e.value }}</code>
          </div>
        </div>
      </div>

      <!-- Output (CodeBlock with syntax highlighting frame) -->
      <div v-if="outputText" class="inspect-output">
        <div class="output-label">输出 ({{ outputLines.length }} 行 · {{ outputText.length }} 字符)</div>
        <CodeBlock :code="outputPreview" :language="outputLang" />
        <button
          v-if="outputHiddenLines > 0"
          class="output-expand-btn"
          @click="outputExpanded = !outputExpanded"
        >
          {{ outputExpanded ? '收起' : `展开剩余 ${outputHiddenLines} 行` }}
        </button>
      </div>
      <div class="inspect-output inspect-empty" v-else-if="!props.call.result">
        <em>执行中...</em>
      </div>
      <div class="inspect-output inspect-empty" v-else>
        <em>无输出</em>
      </div>
    </div>
  </details>
</template>

<style scoped>
.file-inspect {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  font-size: 12px;
  overflow: hidden;
}
.inspect-failed { border-color: rgba(243, 139, 168, 0.3); }

.inspect-summary {
  display: flex; align-items: center; gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-md);
  cursor: pointer; user-select: none; list-style: none;
}
.inspect-summary::-webkit-details-marker { display: none; }

.inspect-icon { flex-shrink: 0; color: var(--color-text-muted); font-size: 11px; }

.inspect-label {
  flex-shrink: 0; font-size: 11px; padding: 1px 6px;
  border-radius: 4px; color: var(--color-teal);
}
.inspect-failed .inspect-label { color: var(--color-red); }

.inspect-path {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex: 1; font-family: var(--font-mono); font-size: 11px; color: var(--color-text-secondary);
}

.inspect-status { flex-shrink: 0; font-size: 11px; color: var(--color-green); }
.inspect-failed .inspect-status { color: var(--color-red); }

.inspect-body {
  padding: var(--spacing-xs) var(--spacing-md) var(--spacing-md);
  border-top: 1px solid var(--border-color);
}

/* ── Args ── */
.inspect-args { margin-bottom: 6px; }

.args-toggle {
  display: inline-flex; align-items: center; gap: 4px;
  border: none; background: transparent; color: var(--color-text-muted);
  font-size: 10px; cursor: pointer; padding: 2px 0;
}
.args-toggle:hover { color: var(--color-text-secondary); }

.args-list { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; padding-left: 4px; }
.args-row { display: flex; gap: 6px; align-items: baseline; }

.args-key {
  font-size: 10px; color: var(--color-text-muted);
  font-family: var(--font-mono); flex-shrink: 0;
}
.args-val {
  font-size: 10px; color: var(--color-text-secondary);
  font-family: var(--font-mono); word-break: break-all;
  background: var(--color-bg-secondary); padding: 0 4px; border-radius: 2px;
}

/* ── Output ── */
.inspect-output { margin-top: 4px; }

.output-label {
  font-size: 10px; color: var(--color-text-muted);
  margin-bottom: 2px; font-weight: 500;
}

.output-expand-btn {
  display: block; width: 100%; margin-top: 4px; padding: 4px 0;
  border: none; background: transparent; color: var(--color-text-muted);
  font-size: 11px; cursor: pointer; text-align: center;
  border-top: 1px solid var(--border-color);
}
.output-expand-btn:hover { color: var(--color-accent); }

.inspect-empty { font-size: 11px; color: var(--color-text-muted); }
</style>
