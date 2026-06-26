<script setup lang="ts">
import { computed } from 'vue';
import type { ToolCallContent } from '@shared/types';
import { parseToolArguments } from '../../utils/tool-presentation';

const props = defineProps<{
  calls: ToolCallContent[];
}>();

// ── Categorize ──

const inspectCalls = computed(() =>
  props.calls.filter((c) => c.name === 'read' || c.name === 'glob' || c.name === 'grep'),
);

const editCalls = computed(() =>
  props.calls.filter((c) => c.name === 'edit' || c.name === 'write'),
);

const bashCalls = computed(() =>
  props.calls.filter((c) => c.name === 'bash'),
);

const subagentCalls = computed(() =>
  props.calls.filter((c) => c.name === 'subagent'),
);

const otherCalls = computed(() =>
  props.calls.filter(
    (c) =>
      !['read', 'glob', 'grep', 'edit', 'write', 'bash', 'subagent'].includes(c.name),
  ),
);

// ── File inspect merged line ──

/** The label for the merged inspect line ("读取" / "查找" / "搜索"). */
const inspectLabel = computed(() => {
  const names = new Set(inspectCalls.value.map((c) => c.name));
  if (names.size === 1) {
    const name = inspectCalls.value[0]?.name;
    if (name === 'read') return '读取';
    if (name === 'glob') return '查找';
    if (name === 'grep') return '搜索';
  }
  return '查看';
});

/** Comma-separated file targets, latest first. */
const inspectTarget = computed(() => {
  const files = inspectCalls.value.map((c) => {
    const args = parseToolArguments(c.arguments);
    return (args.file_path as string) || (args.pattern as string) || '';
  });
  // Show latest file first, truncate each
  const latest = files.slice(-3).reverse();
  return latest.map((f) => f.split('/').pop() || f.split('\\').pop() || f).join(', ');
});

const inspectStatus = computed(() => {
  const running = inspectCalls.value.some((c) => c.status === 'running');
  if (running) return '读取中...';
  const failed = inspectCalls.value.filter(
    (c) => c.status === 'error' || c.result?.success === false,
  ).length;
  if (failed > 0) return `${inspectCalls.value.length - failed}/${inspectCalls.value.length} 完成`;
  return `${inspectCalls.value.length} 完成`;
});

// ── Per-call helpers ──

function callTarget(call: ToolCallContent): string {
  const args = parseToolArguments(call.arguments);
  const fp = (args.file_path as string) || '';
  if (fp) {
    const short = fp.split('/').pop() || fp.split('\\').pop() || fp;
    return short;
  }
  // For bash, show the command
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

function callIcon(name: string): string {
  if (name === 'edit' || name === 'write') return '✏️';
  if (name === 'bash') return '🔧';
  if (name === 'subagent') return '🤖';
  return '🔹';
}

function callStatusText(call: ToolCallContent): string {
  if (call.status === 'running') return '执行中...';
  if (call.status === 'error' || call.result?.success === false) return '失败';
  return '完成';
}

function callStatusClass(call: ToolCallContent): string {
  if (call.status === 'running') return 'status-running';
  if (call.status === 'error' || call.result?.success === false) return 'status-failed';
  return 'status-done';
}
</script>

<template>
  <div class="compact-tool-bar">
    <!-- Merged file inspect line -->
    <div v-if="inspectCalls.length > 0" class="compact-line inspect-line">
      <span class="compact-icon">📖</span>
      <span class="compact-label">{{ inspectLabel }}</span>
      <span class="compact-target">{{ inspectTarget }}</span>
      <span class="compact-status">{{ inspectStatus }}</span>
    </div>

    <!-- Edit tools (each gets a line) -->
    <div
      v-for="call in editCalls"
      :key="call.id"
      class="compact-line"
      :class="callStatusClass(call)"
    >
      <span class="compact-icon">{{ callIcon(call.name) }}</span>
      <span class="compact-label">{{ callLabel(call.name) }}</span>
      <span class="compact-target">{{ callTarget(call) }}</span>
      <span class="compact-status">{{ callStatusText(call) }}</span>
    </div>

    <!-- Bash (each gets a line) -->
    <div
      v-for="call in bashCalls"
      :key="call.id"
      class="compact-line"
      :class="callStatusClass(call)"
    >
      <span class="compact-icon">🔧</span>
      <span class="compact-label">{{ callLabel(call.name) }}</span>
      <span class="compact-target">{{ callTarget(call) }}</span>
      <span class="compact-status">{{ callStatusText(call) }}</span>
    </div>

    <!-- Subagent -->
    <div
      v-for="call in subagentCalls"
      :key="call.id"
      class="compact-line"
      :class="callStatusClass(call)"
    >
      <span class="compact-icon">🤖</span>
      <span class="compact-label">{{ callLabel(call.name) }}</span>
      <span class="compact-target">{{ callTarget(call) }}</span>
      <span class="compact-status">{{ callStatusText(call) }}</span>
    </div>

    <!-- Other tools -->
    <div
      v-for="call in otherCalls"
      :key="call.id"
      class="compact-line"
      :class="callStatusClass(call)"
    >
      <span class="compact-icon">🔹</span>
      <span class="compact-label">{{ call.name }}</span>
      <span class="compact-status">{{ callStatusText(call) }}</span>
    </div>
  </div>
</template>

<style scoped>
.compact-tool-bar {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.compact-line {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  font-size: 11px;
  border-radius: 3px;
  line-height: 1.4;
}

.compact-line.status-running {
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
}

.compact-line.status-failed {
  color: var(--color-red);
}

.compact-icon {
  flex-shrink: 0;
  font-size: 11px;
}

.compact-label {
  flex-shrink: 0;
  font-size: 10px;
  padding: 0 4px;
  border-radius: 2px;
  background: var(--color-surface);
  color: var(--color-text-muted);
}

.compact-target {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-text-secondary);
}

.compact-status {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--color-text-muted);
}

.status-running .compact-status {
  color: var(--color-accent);
}

.status-failed .compact-status {
  color: var(--color-red);
}
</style>
