<script setup lang="ts">
import type { SubagentResult, ToolCallContent } from '@shared/types';
import { computed, nextTick, ref, watch } from 'vue';
import { commandSummary, parseToolArguments } from '../../utils/tool-presentation';
import type { UiLanguage } from '../../utils/ui-language';
import { buildSubagentInlineTrace, type InlineCallTraceEntry } from './call-trace-view-model';
import StreamingText from './StreamingText.vue';

const INLINE_TEXT_LIMIT = 80;

const props = withDefaults(
  defineProps<{
    entries: InlineCallTraceEntry[];
    uiLanguage?: UiLanguage;
    isStreaming?: boolean;
  }>(),
  {
    uiLanguage: 'zh',
    isStreaming: false,
  },
);

// ── helpers (shared) ──

function toolTitle(call: ToolCallContent): string {
  const args = parseToolArguments(call.arguments);
  if (call.name === 'bash') return commandSummary(args);

  const target = toolTarget(args);
  const label = localizedToolLabel(call.name);
  return target ? `${label} ${target}` : label;
}

function toolTarget(args: Record<string, unknown>): string {
  const candidates = [
    args.file_path,
    args.path,
    args.pattern,
    args.query,
    args.agent,
    args.description,
  ];
  const target = candidates.find((candidate): candidate is string => typeof candidate === 'string');
  if (!target) return '';
  return target.length > 90 ? `${target.slice(0, 87)}...` : target;
}

function toolStatus(call: ToolCallContent): string {
  if (props.uiLanguage === 'en') {
    if (call.status === 'running') return 'Running';
    if (call.status === 'error' || call.result?.success === false) return 'Failed';
    return 'Ran';
  }
  if (call.status === 'running') return '正在运行';
  if (call.status === 'error' || call.result?.success === false) return '运行失败';
  return '已运行';
}

function toolStatusClass(call: ToolCallContent): string {
  if (call.status === 'running') return 'running';
  if (call.status === 'error' || call.result?.success === false) return 'failed';
  return 'done';
}

function outputLabel(call: ToolCallContent): string {
  return call.name === 'bash' ? 'Shell' : localizedToolLabel(call.name);
}

function toolOutput(call: ToolCallContent): string {
  const parts: string[] = [];
  const args = parseToolArguments(call.arguments);
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (call.name === 'bash' && command) parts.push(`$ ${command}`);

  if (call.partialOutput) parts.push(call.partialOutput.trimEnd());

  const details = call.result?.details;
  if (details?.type === 'command') {
    if (details.stdout) parts.push(details.stdout.trimEnd());
    if (details.stderr) parts.push(details.stderr.trimEnd());
    if (!details.stdout && !details.stderr && details.exitCode !== undefined) {
      parts.push(`exit=${details.exitCode ?? 'null'}`);
    }
  } else if (call.result?.output) {
    parts.push(call.result.output.trimEnd());
  }

  if (call.result?.error) parts.push(call.result.error.trimEnd());

  return parts.filter(Boolean).join('\n');
}

function toolHasOutput(call: ToolCallContent): boolean {
  if (call.name === 'subagent' && (call.result?.subagentResults?.length ?? 0) > 0) return true;
  return toolOutput(call).length > 0;
}

function isRunningSubagent(call: ToolCallContent): boolean {
  return call.name === 'subagent' && call.status === 'running';
}

function hasSubagentResults(call: ToolCallContent): boolean {
  return call.name === 'subagent' && (call.result?.subagentResults?.length ?? 0) > 0;
}

function subagentStatusText(output: string): string {
  if (props.uiLanguage === 'en' && output === '执行中...') return 'Running...';
  return output;
}

function localizedToolLabel(name: string): string {
  if (props.uiLanguage === 'en') {
    switch (name) {
      case 'read':
        return 'Read';
      case 'glob':
        return 'Find';
      case 'grep':
        return 'Search';
      case 'edit':
        return 'Edit';
      case 'write':
        return 'Write';
      case 'subagent':
        return 'Agent';
      default:
        return name;
    }
  }

  switch (name) {
    case 'bash':
      return '运行命令';
    case 'read':
      return '读取';
    case 'glob':
      return '查找';
    case 'grep':
      return '搜索';
    case 'edit':
      return '编辑';
    case 'write':
      return '写入';
    case 'subagent':
      return '代理';
    default:
      return name;
  }
}

function emptyOutputLabel(): string {
  return props.uiLanguage === 'en' ? 'No output yet' : '暂无输出';
}

// ── streaming helpers ──

function streamingToolLabel(call: ToolCallContent): string {
  const args = parseToolArguments(call.arguments);
  const target = toolTarget(args);
  if (call.name === 'bash') {
    const cmd = commandSummary(args);
    return target ? `${cmd}` : cmd;
  }
  const label = localizedStreamingToolName(call.name);
  return target ? `${label}: ${target}` : label;
}

function streamingToolEntryLabel(call: ToolCallContent): string {
  const prefix = props.uiLanguage === 'en' ? 'Tool' : '工具';
  return `${prefix} · ${streamingToolLabel(call)}`;
}

function localizedStreamingToolName(name: string): string {
  if (props.uiLanguage === 'en') {
    switch (name) {
      case 'read':
        return 'read';
      case 'glob':
        return 'glob';
      case 'grep':
        return 'grep';
      case 'edit':
        return 'edit';
      case 'write':
        return 'write';
      case 'subagent':
        return 'subagent';
      case 'bash':
        return 'bash';
      default:
        return name;
    }
  }
  // Chinese: use English short names for the tree view
  switch (name) {
    case 'read':
      return 'read';
    case 'glob':
      return 'glob';
    case 'grep':
      return 'grep';
    case 'edit':
      return 'edit';
    case 'write':
      return 'write';
    case 'subagent':
      return 'subagent';
    case 'bash':
      return 'bash';
    default:
      return name;
  }
}

function streamingStatusText(call: ToolCallContent): string {
  if (call.status === 'running') {
    return props.uiLanguage === 'en' ? 'Running' : '运行中';
  }
  if (call.status === 'error' || call.result?.success === false) {
    return props.uiLanguage === 'en' ? 'Failed' : '失败';
  }
  if (call.status === 'done' || call.result?.success === true) {
    return props.uiLanguage === 'en' ? 'Done ✓' : '已完成 ✓';
  }
  // No status yet — tool declared but not started
  return props.uiLanguage === 'en' ? 'Waiting...' : '等待中...';
}

function streamingStatusClass(call: ToolCallContent): string {
  if (call.status === 'running') return 'streaming-running';
  if (call.status === 'error' || call.result?.success === false) return 'streaming-failed';
  if (!call.status) return 'streaming-pending';
  return 'streaming-done';
}

function showStreamingOutput(call: ToolCallContent): boolean {
  return (call.status === 'running' || call.status === 'error') && Boolean(call.partialOutput);
}

// ── streaming output auto-scroll ──

const outputRefs = ref<Map<string, HTMLElement>>(new Map());

function setOutputRef(id: string, el: Element | null): void {
  if (el) outputRefs.value.set(id, el as HTMLElement);
}

// Flatten all tool calls to watch their partialOutput
const allPartialOutputs = computed(() => {
  const vals: string[] = [];
  for (const entry of props.entries) {
    if (entry.kind === 'tools') {
      for (const tc of entry.toolCalls) {
        vals.push(tc.partialOutput || '');
      }
    }
  }
  return vals;
});

watch(
  allPartialOutputs,
  () => {
    void nextTick(() => {
      requestAnimationFrame(() => {
        for (const [, el] of outputRefs.value) {
          el.scrollTop = el.scrollHeight;
        }
      });
    });
  },
  { deep: true },
);

// ── subagent helpers ──

function subResultTrace(result: SubagentResult, isStreaming: boolean) {
  return buildSubagentInlineTrace(result, isStreaming, props.uiLanguage);
}

// ── entry helpers ──

/** Get the single tool call from an entry (entries have exactly 1 tool call during streaming). */
function entryToolCall(entry: InlineCallTraceEntry): ToolCallContent | undefined {
  if (entry.kind !== 'tools') return undefined;
  return entry.toolCalls[0];
}

function isLastEntry(index: number): boolean {
  return index === props.entries.length - 1;
}

function isShortInlineText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= INLINE_TEXT_LIMIT && !trimmed.includes('\n');
}

function inlineTextPreview(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function thinkingLabel(entry: InlineCallTraceEntry): string {
  if (entry.kind !== 'thinking') return props.uiLanguage === 'en' ? 'Thinking' : '思考';
  return props.uiLanguage === 'en' ? 'Thinking' : '思考';
}

function outputEntryLabel(entry: InlineCallTraceEntry): string {
  if (entry.kind !== 'text') return props.uiLanguage === 'en' ? 'Output' : '输出';
  const label = props.uiLanguage === 'en' ? 'Output' : '输出';
  return `${label} · ${entry.text.length}`;
}
</script>

<template>
  <!-- ═══ Streaming tree view ═══ -->
  <div v-if="isStreaming" class="streaming-trace-tree">
    <div
      v-for="(entry, entryIdx) in entries"
      :key="entry.id"
      class="tree-branch"
      :class="{ 'tree-branch-last': isLastEntry(entryIdx) }"
    >
      <!-- Thinking line -->
      <div
        v-if="entry.kind === 'thinking' && isShortInlineText(entry.text)"
        class="tree-line tree-inline-text-line tree-line-thinking"
      >
        <span class="tree-think-label">{{ thinkingLabel(entry) }}</span>
        <span class="tree-inline-text">{{ inlineTextPreview(entry.text) }}</span>
      </div>
      <details v-else-if="entry.kind === 'thinking'" class="tree-details tree-thinking">
        <summary class="tree-line tree-line-thinking">
          <span class="tree-think-label">{{ thinkingLabel(entry) }}</span>
        </summary>
        <div class="tree-detail-body tree-think-text">
          {{ entry.text }}
        </div>
      </details>

      <!-- Text line -->
      <div
        v-else-if="entry.kind === 'text' && isShortInlineText(entry.text)"
        class="tree-line tree-inline-text-line tree-line-output"
      >
        <span class="tree-output-label">{{ outputEntryLabel(entry) }}</span>
        <span class="tree-inline-text tree-inline-output-text">
          {{ inlineTextPreview(entry.text) }}
        </span>
      </div>
      <details v-else-if="entry.kind === 'text'" class="tree-details tree-output-details" open>
        <summary class="tree-line tree-line-output">
          <span class="tree-output-label">{{ outputEntryLabel(entry) }}</span>
        </summary>
        <div class="tree-answer-fragment">
          <StreamingText :text="entry.text" :is-streaming="isStreaming && entry.isCurrent" />
        </div>
      </details>

      <!-- Tool line -->
      <details v-else class="tree-details tree-tool-details">
        <summary
          class="tree-line tree-line-tool"
          :class="{ 'tree-line-active': entry.hasRunning }"
        >
          <span class="tree-tool-label">{{ streamingToolEntryLabel(entryToolCall(entry)!) }}</span>
          <span
            class="tree-tool-status"
            :class="streamingStatusClass(entryToolCall(entry)!)"
          >
            <template v-if="entryToolCall(entry)!.status === 'running'">
              <span class="status-progress-bar" />
              {{ streamingStatusText(entryToolCall(entry)!) }}
            </template>
            <template v-else>
              {{ streamingStatusText(entryToolCall(entry)!) }}
            </template>
          </span>
        </summary>

        <!-- Inline output for running tool -->
        <div
          v-if="showStreamingOutput(entryToolCall(entry)!)"
          class="tree-output"
        >
          <pre
            class="tree-output-text"
            :ref="(el) => setOutputRef(entryToolCall(entry)!.id, el as Element)"
          >{{ entryToolCall(entry)!.partialOutput?.trimEnd() }}</pre>
        </div>

        <!-- Subagent nested tree -->
        <div v-if="hasSubagentResults(entryToolCall(entry)!)" class="tree-subagent">
          <div
            v-for="result in entryToolCall(entry)!.result?.subagentResults"
            :key="result.agent"
            class="tree-subagent-result"
          >
            <div class="tree-subagent-header">
              <span class="tree-subagent-name">{{ result.agent }}</span>
              <span class="tree-subagent-meta">
                <template v-if="isRunningSubagent(entryToolCall(entry)!) && result.output === '执行中...'">
                  {{ uiLanguage === 'en' ? 'Running' : '执行中' }}
                </template>
                <template v-else>
                  {{ result.tokenUsage.total }} tokens · {{ result.toolCalls }}
                </template>
              </span>
            </div>
            <InlineCallTrace
              v-if="subResultTrace(result, isRunningSubagent(entryToolCall(entry)!)).entries.length > 0"
              :entries="subResultTrace(result, isRunningSubagent(entryToolCall(entry)!)).entries"
              :ui-language="uiLanguage"
              :is-streaming="isRunningSubagent(entryToolCall(entry)!)"
            />
            <pre
              v-if="result.output && result.output !== '执行中...'"
              class="tree-output-text tree-subagent-output"
            >{{ subagentStatusText(result.output) }}</pre>
            <div v-if="result.error" class="tree-error-text">{{ result.error }}</div>
          </div>
        </div>
      </details>
    </div>
  </div>

  <!-- ═══ Completed (details) view ═══ -->
  <div v-else class="inline-call-trace">
    <template v-for="entry in entries" :key="entry.id">
      <div
        v-if="entry.kind === 'thinking' && isShortInlineText(entry.text)"
        class="trace-inline-text-row trace-thinking-inline"
        :class="{ current: entry.isCurrent }"
      >
        <span class="trace-inline-label">{{ thinkingLabel(entry) }}</span>
        <span class="trace-inline-text">{{ inlineTextPreview(entry.text) }}</span>
      </div>

      <details
        v-else-if="entry.kind === 'thinking'"
        class="trace-thinking-details"
        :class="{ current: entry.isCurrent }"
      >
        <summary class="trace-thinking-summary">{{ thinkingLabel(entry) }}</summary>
        <div class="trace-node-text">{{ entry.text }}</div>
      </details>

      <div
        v-else-if="entry.kind === 'text' && isShortInlineText(entry.text)"
        class="trace-inline-text-row trace-output-inline"
        :class="{ current: entry.isCurrent }"
      >
        <span class="trace-inline-label">{{ outputEntryLabel(entry) }}</span>
        <span class="trace-inline-text">{{ inlineTextPreview(entry.text) }}</span>
      </div>

      <details
        v-else-if="entry.kind === 'text'"
        class="trace-output-details"
        :class="{ current: entry.isCurrent }"
      >
        <summary class="trace-output-summary">{{ outputEntryLabel(entry) }}</summary>
        <div class="trace-answer-fragment">
          <StreamingText :text="entry.text" :is-streaming="isStreaming && entry.isCurrent" />
        </div>
      </details>

      <details
        v-else
        class="trace-tool-group"
        :class="{ running: entry.hasRunning, failed: entry.hasFailed, current: entry.isCurrent }"
        :open="entry.isCurrent || entry.hasRunning"
      >
        <summary class="trace-tool-group-summary">
          <span class="trace-tool-icon">&gt;</span>
          <span>{{ entry.label }}</span>
        </summary>

        <div class="trace-tool-list">
          <details
            v-for="call in entry.toolCalls"
            :key="call.id"
            class="trace-tool-item"
            :class="toolStatusClass(call)"
            :open="call.status === 'running' && toolHasOutput(call)"
          >
            <summary class="trace-tool-item-summary">
              <span class="trace-tool-status">{{ toolStatus(call) }}</span>
              <span class="trace-tool-title">{{ toolTitle(call) }}</span>
            </summary>

            <div class="trace-tool-output">
              <div class="trace-tool-output-label">{{ outputLabel(call) }}</div>
              <div v-if="hasSubagentResults(call)" class="trace-subagents">
                <div
                  v-for="result in call.result?.subagentResults"
                  :key="result.agent"
                  class="trace-subagent"
                >
                  <div class="trace-subagent-header">
                    <span>{{ result.agent }}</span>
                    <span class="trace-subagent-meta">
                      <template v-if="isRunningSubagent(call) && result.output === '执行中...'">
                        {{ uiLanguage === 'en' ? 'Running' : '执行中' }}
                      </template>
                      <template v-else>
                        {{ result.tokenUsage.total }} tokens · {{ result.toolCalls }}
                      </template>
                    </span>
                  </div>
                  <InlineCallTrace
                    v-if="buildSubagentInlineTrace(result, isRunningSubagent(call), uiLanguage).entries.length > 0"
                    :entries="buildSubagentInlineTrace(result, isRunningSubagent(call), uiLanguage).entries"
                    :ui-language="uiLanguage"
                  />
                  <pre
                    v-if="result.output && result.output !== '执行中...'"
                    class="trace-tool-output-text trace-subagent-output"
                  >{{ subagentStatusText(result.output) }}</pre>
                  <div v-if="result.error" class="trace-tool-empty">{{ result.error }}</div>
                </div>
              </div>
              <pre v-else-if="toolHasOutput(call)" class="trace-tool-output-text">{{ toolOutput(call) }}</pre>
              <div v-else class="trace-tool-empty">{{ emptyOutputLabel() }}</div>
            </div>
          </details>
        </div>
      </details>
    </template>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════
   Streaming tree view
   ═══════════════════════════════════════════ */

.streaming-trace-tree {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
}

.tree-branch {
  position: relative;
  padding-left: 18px;
}

/* Vertical line */
.tree-branch::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 0;
  height: 100%;
  border-left: 1px solid var(--border-color);
  pointer-events: none;
}

/* Last branch: truncate vertical line at connector level */
.tree-branch-last::before {
  height: 0.75em;
}

/* Horizontal connector */
.tree-branch::after {
  content: '';
  position: absolute;
  left: 2px;
  top: 0.75em;
  width: 10px;
  border-top: 1px solid var(--border-color);
  pointer-events: none;
}

/* Thinking line */
.tree-line {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-height: 1.6em;
  padding: 1px 0;
}

.tree-line-active {
  width: fit-content;
  max-width: 100%;
  overflow: hidden;
}

.tree-line-active::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    110deg,
    transparent 0%,
    color-mix(in srgb, var(--color-accent) 24%, transparent) 45%,
    transparent 70%
  );
  transform: translateX(-120%);
  animation: trace-shimmer-sweep 2.8s ease-in-out infinite;
  pointer-events: none;
}

@keyframes trace-shimmer-sweep {
  to {
    transform: translateX(120%);
  }
}

.tree-line-thinking {
  padding: 2px 0 4px;
}

.tree-line-output {
  padding: 2px 0 4px;
}

.tree-details {
  min-width: 0;
}

.tree-details > summary {
  cursor: pointer;
  list-style: none;
}

.tree-details > summary::-webkit-details-marker {
  display: none;
}

.tree-details > summary::after {
  content: '>';
  display: inline-block;
  margin-left: 6px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: currentColor;
  opacity: 0.65;
  transition: transform 0.15s;
}

.tree-details[open] > summary::after {
  transform: rotate(90deg);
}

.tree-think-label {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.tree-output-label {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.tree-inline-text-line {
  min-width: 0;
}

.tree-inline-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.tree-inline-output-text {
  font-size: 13px;
  color: var(--color-text);
}

.tree-think-text {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-muted);
  white-space: pre-wrap;
}

.tree-detail-body {
  padding: 4px 0 8px;
}

.tree-answer-fragment {
  color: var(--color-text);
  font-size: 14px;
  line-height: 1.6;
  padding: 3px 0 7px;
}

.tree-output-details .tree-answer-fragment {
  padding: 2px 0 8px;
}

/* Tool line */
.tree-line-tool {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.tree-tool-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.tree-tool-status {
  flex: 0 0 auto;
  margin-left: 8px;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.streaming-running {
  color: var(--color-accent);
}

.streaming-done {
  color: var(--color-green);
}

.streaming-failed {
  color: var(--color-red);
}

.streaming-pending {
  color: var(--color-text-muted);
}

/* Progress bar for running tools */
.status-progress-bar {
  display: inline-block;
  width: 64px;
  height: 10px;
  border-radius: 3px;
  background: var(--color-bg-tertiary);
  overflow: hidden;
  vertical-align: middle;
  position: relative;
}

.status-progress-bar::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    90deg,
    var(--color-accent) 0px,
    var(--color-accent) 4px,
    transparent 4px,
    transparent 8px
  );
  animation: progress-slide 0.7s linear infinite;
}

@keyframes progress-slide {
  to {
    transform: translateX(100%);
  }
}

/* Inline output for running tool */
.tree-output {
  position: relative;
  padding-left: 18px;
  margin: 2px 0 6px;
}

.tree-output-text {
  margin: 0;
  max-height: 180px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-all;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--color-bg-tertiary);
}

/* Subagent in streaming tree */
.tree-subagent {
  position: relative;
  padding-left: 18px;
  margin: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tree-subagent-result {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tree-subagent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tree-subagent-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
}

.tree-subagent-meta {
  font-size: 10px;
  color: var(--color-text-muted);
  flex: 0 0 auto;
}

.tree-subagent-output {
  margin-top: 2px;
}

.tree-error-text {
  font-size: 11px;
  color: var(--color-red);
}

/* ═══════════════════════════════════════════
   Completed (details) view — unchanged
   ═══════════════════════════════════════════ */

.inline-call-trace {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.trace-node-text {
  font-size: 14px;
  line-height: 1.75;
  color: var(--color-text);
  white-space: pre-wrap;
}

.trace-node-text.current {
  color: var(--color-text-secondary);
}

.trace-thinking-details {
  color: var(--color-text-muted);
}

.trace-inline-text-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
  line-height: 1.5;
}

.trace-inline-label {
  flex: 0 0 auto;
  color: var(--color-text-muted);
}

.trace-inline-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
}

.trace-output-inline .trace-inline-text {
  color: var(--color-text);
}

.trace-thinking-summary,
.trace-output-summary {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  list-style: none;
  font-size: 13px;
  line-height: 1.4;
}

.trace-thinking-summary::-webkit-details-marker,
.trace-output-summary::-webkit-details-marker {
  display: none;
}

.trace-thinking-summary::after,
.trace-output-summary::after {
  content: '>';
  display: inline-block;
  margin-left: 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: currentColor;
  opacity: 0.65;
  transition: transform 0.15s;
}

.trace-thinking-details[open] > .trace-thinking-summary::after,
.trace-output-details[open] > .trace-output-summary::after {
  transform: rotate(90deg);
}

.trace-thinking-details .trace-node-text {
  margin-top: 8px;
  color: var(--color-text-secondary);
}

.trace-output-details .trace-answer-fragment {
  margin-top: 8px;
}

.trace-answer-fragment {
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-text);
}

.trace-answer-fragment.current {
  color: var(--color-text-secondary);
}

.trace-tool-group {
  color: var(--color-text-muted);
}

.trace-tool-group.running {
  color: var(--color-accent);
}

.trace-tool-group.failed {
  color: var(--color-red);
}

.trace-tool-group-summary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  cursor: pointer;
  list-style: none;
  font-size: 13px;
  line-height: 1.4;
}

.trace-tool-group-summary::-webkit-details-marker,
.trace-tool-item-summary::-webkit-details-marker {
  display: none;
}

.trace-tool-group-summary::after,
.trace-tool-item-summary::after {
  content: '>';
  display: inline-block;
  margin-left: 2px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: currentColor;
  opacity: 0.65;
  transition: transform 0.15s;
}

.trace-tool-group[open] > .trace-tool-group-summary::after,
.trace-tool-item[open] > .trace-tool-item-summary::after {
  transform: rotate(90deg);
}

.trace-tool-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: currentColor;
}

.trace-tool-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0 0 22px;
}

.trace-tool-item {
  color: var(--color-text-muted);
}

.trace-tool-item.running {
  color: var(--color-accent);
}

.trace-tool-item.failed {
  color: var(--color-red);
}

.trace-tool-item-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
  list-style: none;
  font-size: 13px;
  line-height: 1.45;
}

.trace-tool-status {
  flex: 0 0 auto;
}

.trace-tool-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
}

.trace-tool-output {
  margin: 8px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.trace-tool-output-label {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.trace-tool-output-text {
  margin: 0;
  max-height: 280px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
}

.trace-tool-empty {
  font-size: 12px;
  color: var(--color-text-muted);
}

.trace-subagents {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.trace-subagent {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.trace-subagent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  font-weight: 600;
}

.trace-subagent-meta {
  flex: 0 0 auto;
  color: var(--color-text-muted);
  font-weight: 400;
}

.trace-subagent-output {
  margin-top: 2px;
}
</style>
