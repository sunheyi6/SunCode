<script setup lang="ts">
import type { ToolCallContent } from '@shared/types';
import { computed, ref, watch } from 'vue';
import { bridge } from '../../api/bridge';
import type { ChatMessage } from '../../stores/chat';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import CommandOperationCard from '../tools/CommandOperationCard.vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import FileInspectCard from '../tools/FileInspectCard.vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import FileOperationCard from '../tools/FileOperationCard.vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import SubagentCard from '../tools/SubagentCard.vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import ToolMarkdownOutput from '../tools/ToolMarkdownOutput.vue';
import type { CallTraceSection, CallTraceTurnEntry } from './call-trace-view-model';
import { buildCallTraceOutline } from './call-trace-view-model';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import StreamingText from './StreamingText.vue';

const SYSTEM_PROMPT_PREVIEW_LEN = 500;
const showFullSystemPrompt = ref(false);

const OUTPUT_PREVIEW_LINES = 5;
const expandedOutputs = ref(new Set<string>());

function toggleOutput(toolCallId: string): void {
  const s = expandedOutputs.value;
  if (s.has(toolCallId)) {
    s.delete(toolCallId);
  } else {
    s.add(toolCallId);
  }
  // Trigger reactivity
  expandedOutputs.value = new Set(s);
}

function outputPreview(text: string, toolCallId: string): { text: string; hidden: number } {
  const lines = text.split('\n');
  if (expandedOutputs.value.has(toolCallId) || lines.length <= OUTPUT_PREVIEW_LINES) {
    return { text, hidden: 0 };
  }
  return {
    text: lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n'),
    hidden: lines.length - OUTPUT_PREVIEW_LINES,
  };
}

const props = defineProps<{
  messages: ChatMessage[];
  systemPrompt: string;
  sessionId?: string;
  workingDir?: string;
}>();

defineEmits<{
  close: [];
}>();

const outline = computed(() =>
  buildCallTraceOutline({
    messages: props.messages,
    systemPrompt: props.systemPrompt,
  }),
);

const traceFilePath = ref('');

async function refreshTraceFilePath(): Promise<void> {
  if (!props.sessionId) {
    traceFilePath.value = '';
    return;
  }
  try {
    traceFilePath.value = await bridge.getSessionFilePath(props.sessionId);
  } catch {
    traceFilePath.value = '';
  }
}

watch(
  () => props.sessionId,
  () => {
    void refreshTraceFilePath();
  },
  { immediate: true },
);

const systemPromptText = computed(() => outline.value.systemPrompt?.text ?? '');

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const systemPromptPreview = computed(() => {
  if (showFullSystemPrompt.value || systemPromptText.value.length <= SYSTEM_PROMPT_PREVIEW_LEN) {
    return systemPromptText.value;
  }
  return `${systemPromptText.value.slice(0, SYSTEM_PROMPT_PREVIEW_LEN)}...`;
});

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function openTraceFolder(): void {
  const p = traceFilePath.value;
  if (!p) return;
  bridge.showItemInFolder(p);
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
async function copyTraceFilePath(): Promise<void> {
  const p = traceFilePath.value;
  if (!p) return;
  try {
    await navigator.clipboard.writeText(p);
  } catch {
    /* ignore */
  }
}

function formatTokens(n?: number): string {
  if (n === undefined || n === 0) return '-';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function turnSummary(entry: CallTraceTurnEntry): string {
  const parts: string[] = [];
  if (entry.summary.durationMs !== undefined) parts.push(formatDuration(entry.summary.durationMs));
  parts.push(`in ${formatTokens(entry.summary.inputTokens)}`);
  parts.push(`out ${formatTokens(entry.summary.outputTokens)}`);
  if (entry.summary.toolCount > 0) {
    const failed =
      entry.summary.failedToolCount > 0 ? `，失败${entry.summary.failedToolCount}` : '';
    parts.push(`工具 ${entry.summary.completedToolCount}/${entry.summary.toolCount}${failed}`);
  }
  if (entry.summary.stopReason) parts.push(entry.summary.stopReason);
  if (entry.isStreaming) parts.push('进行中');
  return parts.join(' · ');
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function sectionMeta(section: CallTraceSection): string {
  if (section.kind === 'input') return `system ${formatTokens(section.systemTokens)}`;
  if (section.kind === 'tools') return `${section.itemCount} 个`;
  return `${section.charCount} 字符`;
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function toolSummary(tc: ToolCallContent): string {
  try {
    const args = JSON.parse(tc.arguments) as Record<string, unknown>;
    switch (tc.name) {
      case 'bash':
        return `bash ${String(args.command || '').slice(0, 60)}`;
      case 'write':
        return `write ${String(args.file_path || '')}`;
      case 'edit':
        return `edit ${String(args.file_path || '')}`;
      case 'read':
        return `read ${String(args.file_path || '')}`;
      case 'grep':
        return `grep ${String(args.pattern || '')}`;
      case 'glob':
        return `glob ${String(args.pattern || '')}`;
      case 'ls':
        return `ls ${String(args.path || '')}`;
      case 'subagent':
        return `subagent: ${String(args.agent || '')}`;
      default:
        return tc.name;
    }
  } catch {
    return tc.name;
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function toolStatusLabel(tc: ToolCallContent): string {
  if (tc.status === 'running') return '执行中';
  if (tc.status === 'error' || tc.result?.success === false) return '失败';
  if (tc.status === 'done' || tc.result) return '完成';
  return '待执行';
}

function toolCommand(tc: ToolCallContent): string | undefined {
  try {
    const args = JSON.parse(tc.arguments) as Record<string, unknown>;
    return typeof args.command === 'string' ? args.command : undefined;
  } catch {
    return undefined;
  }
}

function toolResultOutput(tc: ToolCallContent): string {
  return tc.result?.error || tc.result?.output || '无输出';
}

function detectOutputLang(tc: ToolCallContent): string | undefined {
  if (tc.name === 'bash') return 'bash';
  if (tc.name === 'web-search' || tc.name === 'web-fetch') return 'json';
  try {
    const args = JSON.parse(tc.arguments);
    if (tc.name === 'read') {
      const fp = (args.file_path as string) || '';
      const ext = fp.split('.').pop()?.toLowerCase();
      const map: Record<string, string> = {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        vue: 'html',
        html: 'html',
        css: 'css',
        py: 'python',
        rs: 'rust',
        go: 'go',
        java: 'java',
        json: 'json',
        yaml: 'yaml',
        yml: 'yaml',
        xml: 'xml',
        md: 'markdown',
        sh: 'bash',
        sql: 'sql',
        toml: 'toml',
      };
      if (ext && map[ext]) return map[ext];
    }
  } catch {
    /* ignore */
  }
  return undefined;
}
</script>

<template>
  <aside class="call-trace-panel">
    <div class="trace-header">
      <span class="trace-title">调用轨迹</span>
      <div class="trace-header-actions">
        <button
          class="trace-folder-btn"
          title="在文件管理器中打开会话文件"
          @click="openTraceFolder"
        >
          打开文件夹        </button>
        <button class="trace-close" title="关闭" @click="$emit('close')">×</button>
      </div>
    </div>

    <div class="trace-path-bar">
      <span class="trace-path-label">会话文件</span>
      <span class="trace-path-value">{{ traceFilePath || '-' }}</span>
      <button
        v-if="traceFilePath"
        class="trace-path-copy-btn"
        title="复制绝对路径"
        @click="copyTraceFilePath"
      >
        复制
      </button>
    </div>

    <div class="trace-body">
      <details v-if="outline.systemPrompt" class="trace-section">
        <summary class="trace-section-header">
          <span>系统提示词</span>
          <span class="trace-section-meta">{{ outline.systemPrompt.charCount }} 字符</span>
        </summary>
        <pre class="trace-pre">{{ systemPromptPreview }}</pre>
        <button
          v-if="systemPromptText.length > SYSTEM_PROMPT_PREVIEW_LEN"
          class="trace-expand-btn"
          @click="showFullSystemPrompt = !showFullSystemPrompt"
        >
          {{ showFullSystemPrompt ? '收起' : `展开全文 (${systemPromptText.length} 字符)` }}
        </button>
      </details>

      <div v-if="outline.entries.length === 0" class="trace-empty">暂无调用记录</div>

      <template v-for="entry in outline.entries" :key="entry.id">
        <details v-if="entry.kind === 'user'" class="outline-row outline-user">
          <summary class="outline-summary">
            <span class="outline-caret">▸</span>
            <span class="outline-title">用户请求</span>
            <span class="outline-preview">{{ entry.content }}</span>
            <span class="outline-meta">{{ formatTime(entry.timestamp) }}</span>
          </summary>
          <div class="outline-body">
            <p class="outline-user-content">{{ entry.content }}</p>
          </div>
        </details>

        <details
          v-else
          class="outline-row outline-turn"
          :class="{
            'outline-running': entry.isStreaming,
            'outline-failed': entry.summary.failedToolCount > 0,
          }"
          :open="entry.isStreaming"
        >
          <summary class="outline-summary">
            <span class="outline-caret">▸</span>
            <span class="outline-title">第 {{ entry.turnNumber }} 轮模型调用</span>
            <span v-if="entry.modelLabel" class="outline-chip">{{ entry.modelLabel }}</span>
            <span class="outline-meta">{{ turnSummary(entry) }}</span>
          </summary>

          <div class="outline-body">
            <template v-for="section in entry.sections" :key="`${entry.id}:${section.kind}`">
              <details class="outline-section" :open="section.defaultOpen">
                <summary class="outline-section-summary">
                  <span class="outline-caret">▸</span>
                  <span class="outline-section-title">{{ section.title }}</span>
                  <span class="outline-section-meta">{{ sectionMeta(section) }}</span>
                </summary>

                <div class="outline-section-body">
                  <template v-if="section.kind === 'input'">
                    <div
                      v-for="(rm, ri) in section.requestMessages"
                      :key="ri"
                      class="trace-request-message"
                    >
                      <div class="trace-request-role">
                        {{ rm.role.toUpperCase() }} · {{ rm.length }} 字符
                      </div>
                      <pre class="trace-request-preview">{{ rm.content || rm.preview }}</pre>
                    </div>
                  </template>

                  <StreamingText
                    v-else-if="section.kind === 'thinking'"
                    :text="section.text"
                    :is-streaming="false"
                  />

                  <template v-else-if="section.kind === 'tools'">
                    <div v-for="tc in section.toolCalls" :key="tc.id" class="trace-tool-item">
                      <SubagentCard v-if="tc.name === 'subagent'" :call="tc" />
                      <FileOperationCard
                        v-else-if="tc.name === 'edit' || tc.name === 'write'"
                        :call="tc"
                      />
                      <CommandOperationCard v-else-if="tc.name === 'bash'" :call="tc" />
                      <FileInspectCard
                        v-else-if="tc.name === 'read' || tc.name === 'glob' || tc.name === 'grep'"
                        :call="tc"
                      />
                      <details v-else class="trace-generic-tool">
                        <summary class="trace-generic-summary">
                          <span class="trace-generic-name">{{ tc.name }}</span>
                          <span class="trace-generic-text">{{ toolSummary(tc) }}</span>
                          <span
                            class="trace-generic-status"
                            :class="{
                              'trace-status-ok': tc.result?.success,
                              'trace-status-error': tc.result?.success === false,
                            }"
                          >
                            {{ toolStatusLabel(tc) }}
                          </span>
                        </summary>
                        <div class="trace-generic-body">
                          <span class="trace-field-label">参数</span>
                          <ToolMarkdownOutput :output="tc.arguments" />
                          <template v-if="tc.result">
                            <span class="trace-field-label">工具返回</span>
                            <ToolMarkdownOutput
                              :class="{ 'trace-error-text': tc.result.success === false }"
                              :output="toolResultOutput(tc)"
                              :command="toolCommand(tc)"
                            />
                          </template>
                        </div>
                      </details>
                    </div>
                  </template>

                  <StreamingText
                    v-else-if="section.kind === 'response'"
                    :text="section.text"
                    :is-streaming="entry.isStreaming"
                  />
                </div>
              </details>
            </template>
          </div>
        </details>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.call-trace-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  box-sizing: border-box;
  padding-top: 60px;
  background: var(--color-bg);
  border-left: 1px solid var(--border-color);
  overflow: hidden;
}

.trace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 12px;
  height: 38px;
  min-height: 38px;
  border-bottom: 1px solid var(--border-color);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.trace-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}

.trace-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.trace-folder-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-color-strong);
  border-radius: 4px;
  background: var(--color-surface);
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  transition: all 0.12s;
}

.trace-folder-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-accent);
  border-color: var(--color-accent);
}

.trace-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 14px;
}

.trace-close:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.trace-path-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  min-height: 26px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
  background: var(--color-bg-tertiary);
}

.trace-path-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--color-text-muted);
  background: var(--color-surface);
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
}

.trace-path-value {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-path-copy-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background: var(--color-surface);
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
  transition: all 0.12s;
}

.trace-path-copy-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-accent);
  border-color: var(--color-accent);
}

.trace-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 8px;
}

.trace-section,
.outline-row {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  overflow: hidden;
  background: var(--color-bg-secondary);
  margin-bottom: 8px;
}

.trace-section-header,
.outline-summary,
.outline-section-summary,
.trace-generic-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  list-style: none;
  cursor: pointer;
  user-select: none;
}

.trace-section-header {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-text-secondary);
  background: var(--color-surface);
}

.trace-section-header::-webkit-details-marker,
.outline-summary::-webkit-details-marker,
.outline-section-summary::-webkit-details-marker,
.trace-generic-summary::-webkit-details-marker {
  display: none;
}

.trace-section-header::before {
  content: '▸';
  display: inline-block;
  width: 12px;
  color: var(--color-text-muted);
  transition: transform 0.15s;
}

details[open] > .trace-section-header::before,
details[open] > .outline-summary .outline-caret,
details[open] > .outline-section-summary .outline-caret {
  transform: rotate(90deg);
}

.trace-section-header:hover,
.outline-summary:hover,
.outline-section-summary:hover,
.trace-generic-summary:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.trace-section-meta {
  margin-left: auto;
  font-size: 10px;
  color: var(--color-text-muted);
}

.trace-pre {
  margin: 0;
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.5;
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
  background: var(--color-bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.trace-expand-btn {
  display: block;
  width: 100%;
  padding: 5px 10px;
  border: none;
  border-top: 1px solid var(--border-color);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: 11px;
  cursor: pointer;
}

.trace-expand-btn:hover {
  color: var(--color-accent);
}

.outline-summary {
  min-height: 34px;
  padding: 6px 10px;
  background: var(--color-surface);
  color: var(--color-text-secondary);
}

.outline-caret {
  display: inline-flex;
  justify-content: center;
  width: 12px;
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform 0.15s;
}

.outline-title {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
}

.outline-preview,
.outline-meta,
.outline-section-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--color-text-muted);
}

.outline-preview {
  flex: 1;
}

.outline-meta,
.outline-section-meta {
  margin-left: auto;
  flex-shrink: 0;
  font-family: var(--font-mono);
}

.outline-chip {
  min-width: 0;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 1px 5px;
}

.outline-running {
  border-color: var(--color-accent);
}

.outline-failed {
  border-color: rgba(243, 139, 168, 0.35);
}

.outline-body {
  padding: 6px;
  border-top: 1px solid var(--border-color);
  background: var(--color-bg);
}

.outline-user-content {
  margin: 0;
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--color-text);
}

.outline-section {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  overflow: hidden;
  background: var(--color-bg-secondary);
  margin-bottom: 6px;
}

.outline-section:last-child {
  margin-bottom: 0;
}

.outline-section-summary {
  min-height: 30px;
  padding: 5px 8px;
  font-size: 11px;
  color: var(--color-text-secondary);
  background: var(--color-surface);
}

.outline-section-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.outline-section-body {
  padding: 8px;
  background: var(--color-bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.trace-request-message {
  margin-bottom: 6px;
}

.trace-request-message:last-child {
  margin-bottom: 0;
}

.trace-request-role {
  margin-bottom: 2px;
  font-size: 10px;
  font-weight: 600;
  color: var(--color-text-muted);
}

.trace-request-preview,
.trace-generic-body pre {
  margin: 0;
  padding: 5px 6px;
  background: var(--color-bg);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.4;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: min(360px, 45vh);
  overflow-y: auto;
  overscroll-behavior: auto;
}

.trace-tool-item {
  margin-bottom: 6px;
}

.trace-tool-item:last-child {
  margin-bottom: 0;
}

.trace-generic-tool {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  overflow: hidden;
  font-size: 12px;
}

.trace-generic-summary {
  padding: 5px 8px;
}

.trace-generic-name {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-accent);
}

.trace-generic-text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-secondary);
}

.trace-generic-status {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 10px;
  color: var(--color-text-muted);
}

.trace-status-ok {
  color: var(--color-green);
}

.trace-status-error,
.trace-error-text {
  color: var(--color-red) !important;
}

.trace-generic-body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px;
  border-top: 1px solid var(--border-color);
}

.trace-field-label {
  font-size: 10px;
  color: var(--color-text-muted);
  text-transform: uppercase;
}

.trace-empty {
  text-align: center;
  padding: 32px 16px;
  font-size: 12px;
  color: var(--color-text-muted);
}
</style>
