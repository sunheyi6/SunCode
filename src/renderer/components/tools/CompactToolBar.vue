<script setup lang="ts">
import type { ToolCallContent } from '@shared/types';
import { computed } from 'vue';
import { parseToolArguments } from '../../utils/tool-presentation';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import ToolMarkdownOutput from './ToolMarkdownOutput.vue';

const props = defineProps<{
  calls: ToolCallContent[];
}>();

// -- Categories --
const inspectCalls = computed(() =>
  props.calls.filter((c) => c.name === 'read' || c.name === 'glob' || c.name === 'grep'),
);
const editCalls = computed(() =>
  props.calls.filter((c) => c.name === 'edit' || c.name === 'write'),
);
const bashCalls = computed(() => props.calls.filter((c) => c.name === 'bash'));
const subagentCalls = computed(() => props.calls.filter((c) => c.name === 'subagent'));
const otherCalls = computed(() =>
  props.calls.filter(
    (c) => !['read', 'glob', 'grep', 'edit', 'write', 'bash', 'subagent'].includes(c.name),
  ),
);

// -- Inspect merge --
const inspectLabel = computed(() => {
  const names = new Set(inspectCalls.value.map((c) => c.name));
  if (names.size === 1) {
    const n = inspectCalls.value[0]?.name;
    if (n === 'read') return '读取';
    if (n === 'glob') return '查找';
    if (n === 'grep') return '搜索';
  }
  return '查看';
});

const inspectTarget = computed(() => {
  const files = inspectCalls.value.map((c) => {
    const args = parseToolArguments(c.arguments);
    return (args.file_path as string) || (args.pattern as string) || '';
  });
  const latest = files.slice(-3).reverse();
  return latest.map((f) => f.split('/').pop() || f.split('\\').pop() || f).join(', ');
});

const inspectRunning = computed(() => inspectCalls.value.some((c) => c.status === 'running'));

const inspectStatus = computed(() => {
  if (inspectRunning.value) return '读取中...';
  const failed = inspectCalls.value.filter(
    (c) => c.status === 'error' || c.result?.success === false,
  ).length;
  if (failed > 0) return `${inspectCalls.value.length - failed}/${inspectCalls.value.length} 完成`;
  return `${inspectCalls.value.length} 完成`;
});

// -- Per-call helpers --
function callTarget(call: ToolCallContent): string {
  const args = parseToolArguments(call.arguments);
  const fp = (args.file_path as string) || '';
  if (fp) {
    const short = fp.split('/').pop() || fp.split('\\').pop() || fp;
    return short;
  }
  const cmd = (args.command as string) || (args.description as string) || '';
  return cmd.length > 50 ? `${cmd.slice(0, 47)}...` : cmd;
}

function callLabel(name: string): string {
  if (name === 'edit') return '编辑';
  if (name === 'write') return '写入';
  if (name === 'bash') return '运行';
  if (name === 'subagent') return '子代理';
  return name;
}

function callStatusClass(call: ToolCallContent): string {
  if (call.status === 'running') return 'status-running';
  if (call.status === 'error' || call.result?.success === false) return 'status-failed';
  return 'status-done';
}

function resultPreview(call: ToolCallContent): string | null {
  if (!call.result || call.status === 'running') return null;
  // Bash: show stdout tail
  if (call.name === 'bash' && call.result.details?.type === 'command') {
    const d = call.result.details;
    if (d.stdout) {
      const lines = d.stdout.trim().split('\n');
      const tail = lines.slice(-3).join('\n');
      return tail.length > 200 ? `${tail.slice(0, 200)}...` : tail;
    }
    if (d.stderr) return `stderr: ${d.stderr.slice(0, 100)}`;
    return `exit=${d.exitCode ?? '?'}`;
  }
  // Read/grep: show output tail
  if (
    (call.name === 'read' || call.name === 'grep' || call.name === 'glob') &&
    call.result.output
  ) {
    const out = call.result.output;
    return out.length > 200 ? `${out.slice(0, 200)}...` : out;
  }
  // Error fallback
  if (call.result.error) return call.result.error.slice(0, 120);
  return null;
}

function resultCommand(call: ToolCallContent): string | undefined {
  const args = parseToolArguments(call.arguments);
  return typeof args.command === 'string' ? args.command : undefined;
}
</script>

<template>
  <div class="compact-tool-bar">
    <!-- File inspect (merged) -->
    <div v-if="inspectCalls.length > 0" class="compact-line inspect-line" :class="{ 'status-running': inspectRunning }">
      <span v-if="inspectRunning" class="compact-breathe-dot" />
      <span class="compact-icon">$</span>
      <span class="compact-label">{{ inspectLabel }}</span>
      <span class="compact-target">{{ inspectTarget }}</span>
      <span class="compact-status">{{ inspectStatus }}</span>
    </div>

    <!-- Bash (each gets a line + output preview) -->
    <div v-for="call in bashCalls" :key="call.id">
      <div class="compact-line" :class="callStatusClass(call)">
        <span v-if="call.status === 'running'" class="compact-breathe-dot" />
        <span class="compact-icon">&gt;</span>
        <span class="compact-label">{{ callLabel(call.name) }}</span>
        <span class="compact-target">{{ callTarget(call) }}</span>
        <span class="compact-status">{{ call.status === 'running' ? '执行中...' : call.result?.success === false ? '失败' : '完成' }}</span>
      </div>
      <ToolMarkdownOutput
        v-if="resultPreview(call)"
        class="compact-output"
        :output="resultPreview(call) || ''"
        :command="resultCommand(call)"
      />
    </div>

    <!-- Edit/Write (each gets a line + diff summary) -->
    <div v-for="call in editCalls" :key="call.id">
      <div class="compact-line" :class="callStatusClass(call)">
        <span v-if="call.status === 'running'" class="compact-breathe-dot" />
        <span class="compact-icon">+</span>
        <span class="compact-label">{{ callLabel(call.name) }}</span>
        <span class="compact-target">{{ callTarget(call) }}</span>
        <span class="compact-status">{{ call.status === 'running' ? '执行中...' : call.result?.success === false ? '失败' : '完成' }}</span>
      </div>
      <div v-if="call.result?.details?.type === 'file_edit' && call.result.details.status === 'edited'" class="compact-diff-summary">
        <span v-if="call.result.details.addedLines" class="diff-added">+{{ call.result.details.addedLines }}</span>
        <span v-if="call.result.details.removedLines" class="diff-removed">-{{ call.result.details.removedLines }}</span>
      </div>
    </div>

    <!-- Subagent -->
    <div v-for="call in subagentCalls" :key="call.id" class="compact-line" :class="callStatusClass(call)">
      <span v-if="call.status === 'running'" class="compact-breathe-dot" />
      <span class="compact-icon">@</span>
      <span class="compact-label">{{ callLabel(call.name) }}</span>
      <span class="compact-target">{{ callTarget(call) }}</span>
      <span class="compact-status">{{ call.status === 'running' ? '执行中...' : call.result?.success === false ? '失败' : '完成' }}</span>
    </div>

    <!-- Other -->
    <div v-for="call in otherCalls" :key="call.id" class="compact-line" :class="callStatusClass(call)">
      <span v-if="call.status === 'running'" class="compact-breathe-dot" />
      <span class="compact-icon">*</span>
      <span class="compact-label">{{ call.name }}</span>
      <span class="compact-status">{{ call.status === 'running' ? '执行中...' : call.result?.success === false ? '失败' : '完成' }}</span>
    </div>
  </div>
</template>

<style scoped>
.compact-tool-bar { display: flex; flex-direction: column; gap: 1px; }

.compact-line {
  display: flex; align-items: center; gap: 4px;
  padding: 2px 6px; font-size: 11px;
  border-radius: 3px; line-height: 1.4;
}
.compact-line.status-running { background: color-mix(in srgb, var(--color-accent) 8%, transparent); }
.compact-line.status-failed  { color: var(--color-red); }

.compact-icon   { flex-shrink: 0; font-size: 11px; }
.compact-label  { flex-shrink: 0; font-size: 10px; padding: 0 4px; border-radius: 2px; background: var(--color-surface); color: var(--color-text-muted); }
.compact-target { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-family: var(--font-mono); font-size: 10px; color: var(--color-text-secondary); }
.compact-status { flex-shrink: 0; font-size: 10px; color: var(--color-text-muted); }
.status-running .compact-status { color: var(--color-accent); }
.status-failed  .compact-status { color: var(--color-red); }

.compact-breathe-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
  animation: compact-breathe 1.4s ease-in-out infinite;
}

@keyframes compact-breathe {
  0%, 100% {
    opacity: 0.4;
    transform: scale(0.8);
    box-shadow: 0 0 2px 0 color-mix(in srgb, var(--color-accent) 30%, transparent);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
    box-shadow: 0 0 6px 2px color-mix(in srgb, var(--color-accent) 60%, transparent);
  }
}

/* Output preview for completed bash commands */
.compact-output {
  margin: 0 0 1px 20px; padding: 3px 6px;
  font-family: var(--font-mono); font-size: 10px; line-height: 1.3;
  color: var(--color-text-muted);
  white-space: pre-wrap; word-break: break-word;
  max-height: 80px; overflow-y: auto;
  background: var(--color-bg); border-radius: 2px;
  border-left: 2px solid var(--border-color);
}

/* Diff summary for file edits */
.compact-diff-summary {
  margin: 0 0 1px 20px; padding: 1px 6px;
  font-family: var(--font-mono); font-size: 10px;
  display: flex; gap: 8px;
}
.diff-added   { color: var(--color-green); }
.diff-removed { color: var(--color-red); }
</style>
