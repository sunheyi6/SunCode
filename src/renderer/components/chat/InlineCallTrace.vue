<script setup lang="ts">
import type { SubagentResult, ToolCallContent } from '@shared/types';
import { commandSummary, parseToolArguments } from '../../utils/tool-presentation';
import type { UiLanguage } from '../../utils/ui-language';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import ToolMarkdownOutput from '../tools/ToolMarkdownOutput.vue';
import { buildSubagentInlineTrace, type InlineCallTraceEntry } from './call-trace-view-model';
import StreamingText from './StreamingText.vue';

const INLINE_TEXT_LIMIT = 80;

const props = withDefaults(
  defineProps<{
    entries: InlineCallTraceEntry[];
    uiLanguage?: UiLanguage;
    isStreaming?: boolean;
    showThinking?: boolean;
  }>(),
  {
    uiLanguage: 'zh',
    isStreaming: false,
    showThinking: true,
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

function toolOutputCommand(call: ToolCallContent): string | undefined {
  const args = parseToolArguments(call.arguments);
  return typeof args.command === 'string' ? args.command : undefined;
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

// ── subagent helpers ──

function subResultTrace(result: SubagentResult, isStreaming: boolean) {
  return buildSubagentInlineTrace(result, isStreaming, props.uiLanguage);
}

// ── entry helpers ──

function isShortInlineText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= INLINE_TEXT_LIMIT && !trimmed.includes('\n');
}

function inlineTextPreview(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function outputEntryLabel(entry: InlineCallTraceEntry): string {
  if (entry.kind !== 'text') return props.uiLanguage === 'en' ? 'Output' : '输出';
  const label = props.uiLanguage === 'en' ? 'Output' : '输出';
  return `${label} · ${entry.text.length}`;
}

function streamingToolText(entry: InlineCallTraceEntry): string {
  if (entry.kind !== 'tools') return '';
  if (entry.toolCalls.length !== 1) return entry.label;

  const call = entry.toolCalls[0];
  if (!call) return entry.label;
  return toolTitle(call);
}

function streamingToolClass(entry: InlineCallTraceEntry): string {
  if (entry.kind !== 'tools') return '';
  const call = entry.toolCalls[0];
  return call ? toolStatusClass(call) : '';
}
</script>

<template>
  <!-- ═══ Streaming process view ═══ -->
  <div v-if="isStreaming" class="streaming-process-list">
    <template v-for="entry in entries" :key="entry.id">
      <div
        v-if="showThinking && entry.kind === 'thinking'"
        class="streaming-process-text streaming-thinking-text"
        :class="{ active: entry.isActive }"
      >
        <StreamingText :text="entry.text" :is-streaming="isStreaming && entry.isActive" />
      </div>

      <div
        v-else-if="entry.kind === 'text'"
        class="streaming-process-text streaming-progress-summary"
        :class="{ active: entry.isActive }"
      >
        <StreamingText :text="entry.text" :is-streaming="entry.isActive" />
      </div>

      <!-- Mid-run guidance: shown inline (no standalone user bubble) -->
      <div
        v-else-if="entry.kind === 'guidance'"
        class="streaming-guidance"
        :class="{ active: entry.isActive }"
      >
        <span class="streaming-guidance-mark">↳</span>
        <span class="streaming-guidance-label">{{ uiLanguage === 'en' ? 'Guidance' : '引导' }}</span>
        <span class="streaming-guidance-text">{{ entry.text }}</span>
      </div>

      <details
        v-else-if="entry.kind === 'tools'"
        class="streaming-tool-details"
        :class="[streamingToolClass(entry), { current: entry.isCurrent }]"
      >
        <summary class="streaming-tool-row">
          <span class="streaming-tool-dot" :class="streamingToolClass(entry)" />
          <span class="streaming-tool-text">{{ streamingToolText(entry) }}</span>
        </summary>

        <div class="streaming-tool-detail">
          <template v-if="entry.toolCalls.length === 1">
            <ToolMarkdownOutput
              v-if="toolHasOutput(entry.toolCalls[0])"
              class="streaming-tool-output"
              :output="toolOutput(entry.toolCalls[0])"
              :command="toolOutputCommand(entry.toolCalls[0])"
              :is-streaming="entry.toolCalls[0]?.status === 'running'"
            />
            <div v-else class="streaming-tool-empty">{{ emptyOutputLabel() }}</div>
          </template>

          <template v-else>
            <details
              v-for="call in entry.toolCalls"
              :key="call.id"
              class="streaming-tool-call"
            >
              <summary class="streaming-tool-call-summary">
                <span class="streaming-tool-dot" :class="toolStatusClass(call)" />
                <span class="streaming-tool-call-title">{{ toolTitle(call) }}</span>
              </summary>
              <ToolMarkdownOutput
                v-if="toolHasOutput(call)"
                class="streaming-tool-output"
                :output="toolOutput(call)"
                :command="toolOutputCommand(call)"
                :is-streaming="call.status === 'running'"
              />
              <div v-else class="streaming-tool-empty">{{ emptyOutputLabel() }}</div>
            </details>
          </template>
        </div>
      </details>

      <template v-if="entry.kind === 'tools'">
        <div
          v-for="call in entry.toolCalls"
          :key="`${entry.id}:${call.id}:subagent`"
          class="streaming-subagent-results"
        >
          <template v-if="hasSubagentResults(call)">
            <div
              v-for="result in call.result?.subagentResults"
              :key="result.agent"
              class="tree-subagent-result"
            >
              <div class="tree-subagent-header">
                <span class="tree-subagent-name">{{ result.agent }}</span>
                <span class="tree-subagent-meta">
                  <template v-if="isRunningSubagent(call) && result.output === '执行中...'">
                    {{ uiLanguage === 'en' ? 'Running' : '执行中' }}
                  </template>
                  <template v-else>
                    {{ result.tokenUsage.total }} tokens · {{ result.toolCalls }}
                  </template>
                </span>
              </div>
              <InlineCallTrace
                v-if="subResultTrace(result, isRunningSubagent(call)).entries.length > 0"
                :entries="subResultTrace(result, isRunningSubagent(call)).entries"
                :ui-language="uiLanguage"
                :is-streaming="isRunningSubagent(call)"
                :show-thinking="showThinking"
              />
              <ToolMarkdownOutput
                v-if="result.output && result.output !== '执行中...'"
                class="tree-output-text tree-subagent-output"
                :output="subagentStatusText(result.output)"
              />
              <div v-if="result.error" class="tree-error-text">{{ result.error }}</div>
            </div>
          </template>
        </div>
      </template>
    </template>
  </div>

  <!-- ═══ Completed (details) view ═══ -->
  <div v-else class="inline-call-trace">
    <template v-for="entry in entries" :key="entry.id">
      <div
        v-if="showThinking && entry.kind === 'thinking'"
        class="trace-node-text"
        :class="{ current: entry.isCurrent }"
      >
        {{ entry.text }}
      </div>

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

      <div
        v-else-if="entry.kind === 'guidance'"
        class="trace-guidance"
        :class="{ current: entry.isCurrent }"
      >
        <span class="trace-guidance-mark">↳</span>
        <span class="trace-guidance-label">{{ uiLanguage === 'en' ? 'Guidance' : '引导' }}</span>
        <span class="trace-guidance-text">{{ entry.text }}</span>
      </div>

      <details
        v-else-if="entry.kind === 'tools'"
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
                    :show-thinking="showThinking"
                  />
                  <ToolMarkdownOutput
                    v-if="result.output && result.output !== '执行中...'"
                    class="trace-tool-output-text trace-subagent-output"
                    :output="subagentStatusText(result.output)"
                  />
                  <div v-if="result.error" class="trace-tool-empty">{{ result.error }}</div>
                </div>
              </div>
              <ToolMarkdownOutput
                v-else-if="toolHasOutput(call)"
                class="trace-tool-output-text"
                :output="toolOutput(call)"
                :command="toolOutputCommand(call)"
                :is-streaming="call.status === 'running'"
              />
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
   Streaming process view
   ═══════════════════════════════════════════ */

.streaming-process-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 0;
  padding: 0;
}

.streaming-process-text {
  font-size: 14px;
  line-height: 1.75;
  color: var(--color-text);
  white-space: pre-wrap;
}

.streaming-thinking-text {
  color: var(--color-text);
}

.streaming-progress-summary {
  border-left: 2px solid color-mix(in srgb, var(--color-accent) 45%, transparent);
  padding-left: 8px;
  color: var(--color-text-secondary);
}

.streaming-progress-summary.active {
  color: var(--color-text);
}

.streaming-tool-details {
  min-width: 0;
  color: var(--color-text-muted);
}

/* Mid-run guidance chip (streaming) */
.streaming-guidance {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 2px 0;
  padding: 4px 8px;
  border-left: 2px solid var(--color-accent);
  border-radius: 0 4px 4px 0;
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.streaming-guidance.active {
  color: var(--color-text);
}

.streaming-guidance-mark {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-accent);
}

.streaming-guidance-label {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-accent);
}

.streaming-guidance-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.streaming-tool-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  font-size: 14px;
  line-height: 1.75;
  cursor: pointer;
  list-style: none;
}

.streaming-tool-row::-webkit-details-marker,
.streaming-tool-call-summary::-webkit-details-marker {
  display: none;
}

.streaming-tool-details.running .streaming-tool-row {
  color: var(--color-accent);
}

.streaming-tool-details.running.current .streaming-tool-row {
  position: relative;
  overflow: hidden;
}

.streaming-tool-details.running.current .streaming-tool-row::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    110deg,
    transparent 0%,
    color-mix(in srgb, var(--color-accent) 18%, transparent) 45%,
    transparent 70%
  );
  transform: translateX(-120%);
  animation: trace-shimmer-sweep 2.4s ease-in-out infinite;
  pointer-events: none;
}

.streaming-tool-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 8px;
  background: var(--color-green);
}

.streaming-tool-dot.running {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  border: none;
  background: var(--color-accent);
  animation: tool-breathe 1.4s ease-in-out infinite;
}

.streaming-tool-dot.failed {
  background: var(--color-red);
}

@keyframes tool-breathe {
  0%, 100% {
    opacity: 0.4;
    transform: scale(0.8);
    box-shadow: 0 0 2px 0 color-mix(in srgb, var(--color-accent) 30%, transparent);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
    box-shadow: 0 0 8px 2px color-mix(in srgb, var(--color-accent) 60%, transparent);
  }
}

.streaming-tool-details.failed .streaming-tool-row {
  color: var(--color-red);
}

.streaming-tool-details.current .streaming-tool-row {
  color: var(--color-text);
}

.streaming-tool-details.current:not(.running) .streaming-tool-row {
  color: var(--color-text-secondary);
}

.streaming-tool-call[open] > .streaming-tool-call-summary::after {
  transform: rotate(90deg);
}

.streaming-tool-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.streaming-subagent-results {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-left: 22px;
}

.streaming-tool-detail {
  margin: 2px 0 4px 22px;
  color: var(--color-text-secondary);
}

.streaming-tool-call {
  min-width: 0;
}

.streaming-tool-call-summary {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
  list-style: none;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.streaming-tool-call-summary::after {
  content: '▸';
  display: inline-block;
  margin-left: 2px;
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: currentColor;
  opacity: 0.65;
  transition: transform 0.15s;
}

.streaming-tool-call-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.streaming-tool-output {
  margin: 4px 0 6px;
  max-height: 220px;
  overflow: auto;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.streaming-tool-empty {
  margin: 2px 0 6px;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.5;
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
  content: '▸';
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

.streaming-final-pending {
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 3px 0 7px;
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 1.6;
}

.streaming-final-cursor {
  color: var(--color-accent);
  font-weight: 100;
  animation: streaming-final-blink 1s step-end infinite;
}

@keyframes streaming-final-blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
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

.trace-output-summary {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  list-style: none;
  font-size: 13px;
  line-height: 1.4;
}

.trace-output-summary::-webkit-details-marker {
  display: none;
}

.trace-output-summary::after {
  content: '▸';
  display: inline-block;
  margin-left: 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: currentColor;
  opacity: 0.65;
  transition: transform 0.15s;
}

.trace-output-details[open] > .trace-output-summary::after {
  transform: rotate(90deg);
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

/* Mid-run guidance chip (completed view) */
.trace-guidance {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 8px;
  border-left: 2px solid var(--color-accent);
  border-radius: 0 4px 4px 0;
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-text-secondary);
}

.trace-guidance-mark {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-accent);
}

.trace-guidance-label {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-accent);
}

.trace-guidance-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  content: '▸';
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

.trace-tool-item.running .trace-tool-status::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 5px;
  border-radius: 50%;
  vertical-align: middle;
  background: var(--color-accent);
  animation: tool-breathe 1.4s ease-in-out infinite;
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
