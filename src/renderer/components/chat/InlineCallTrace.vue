<script setup lang="ts">
import type { ToolCallContent } from '@shared/types';
import { commandSummary, parseToolArguments } from '../../utils/tool-presentation';
import type { UiLanguage } from '../../utils/ui-language';
import { buildSubagentInlineTrace, type InlineCallTraceEntry } from './call-trace-view-model';

const props = withDefaults(
  defineProps<{
    entries: InlineCallTraceEntry[];
    uiLanguage?: UiLanguage;
  }>(),
  {
    uiLanguage: 'zh',
  },
);

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
</script>

<template>
  <div class="inline-call-trace">
    <template v-for="entry in entries" :key="entry.id">
      <div
        v-if="entry.kind === 'thinking'"
        class="trace-node-text"
        :class="{ current: entry.isCurrent }"
      >
        {{ entry.text }}
      </div>

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
                        {{ props.uiLanguage === 'en' ? 'Running' : '执行中' }}
                      </template>
                      <template v-else>
                        {{ result.tokenUsage.total }} tokens · {{ result.toolCalls }}
                      </template>
                    </span>
                  </div>
                  <InlineCallTrace
                    v-if="buildSubagentInlineTrace(result, isRunningSubagent(call), props.uiLanguage).entries.length > 0"
                    :entries="buildSubagentInlineTrace(result, isRunningSubagent(call), props.uiLanguage).entries"
                    :ui-language="props.uiLanguage"
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
.inline-call-trace {
  display: flex;
  flex-direction: column;
  gap: 14px;
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
