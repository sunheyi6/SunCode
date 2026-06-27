<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChatMessage } from '../../stores/chat';
import type { ToolCallContent, TurnDetail } from '@shared/types';
import { bridge } from '../../api/bridge';
import CommandOperationCard from '../tools/CommandOperationCard.vue';
import FileOperationCard from '../tools/FileOperationCard.vue';
import FileInspectCard from '../tools/FileInspectCard.vue';
import SubagentCard from '../tools/SubagentCard.vue';
import StreamingText from '../chat/StreamingText.vue';

const SYSTEM_PROMPT_PREVIEW_LEN = 500;
const showFullSystemPrompt = ref(false);

const props = defineProps<{
  messages: ChatMessage[];
  systemPrompt: string;
  sessionId?: string;
  workingDir?: string;
}>();

defineEmits<{
  close: [];
}>();

const traceFilePath = computed(() => {
  if (!props.workingDir || !props.sessionId) return '';
  return `${props.workingDir}/.suncode/sessions/${props.sessionId}.json`.replace(/\\/g, '/');
});

function openTraceFolder(): void {
  if (!traceFilePath.value) return;
  bridge.showItemInFolder(traceFilePath.value);
}

// ── Identity-tagged timeline entry ──
type TimelineEntry =
  | { kind: 'user'; id: string; content: string; timestamp: number }
  | { kind: 'llm_call'; turnNumber: number; modelLabel: string; durationMs?: number; inputTokens?: number; outputTokens?: number; stopReason?: string; systemTokens: number; requestMessages: Array<{ role: string; length: number; preview: string }>; thinking: string; responseText: string; toolCalls: ToolCallContent[]; executedToolCalls: ToolCallContent[]; isStreaming: boolean };

const timeline = computed<TimelineEntry[]>(() => {
  const entries: TimelineEntry[] = [];

  for (const msg of props.messages) {
    if (msg.role === 'user') {
      entries.push({
        kind: 'user',
        id: msg.id,
        content: msg.content,
        timestamp: msg.timestamp,
      });
      continue;
    }

    if (msg.role !== 'assistant') continue;

    const details = getTurns(msg);
    const execTools = msg.toolCalls ?? [];

    for (let i = 0; i < details.length; i++) {
      const turn = details[i]!;
      const raw = turn as Record<string, unknown>;
      const provider = (raw.provider as string) || '';
      const model = (raw.model as string) || '';
      const modelLabel = provider && model ? `${provider}/${model}` : '';

      const executedToolCalls = turn.response.toolCalls.map((llmTc) => {
        const execTc = execTools.find((et) => et.id === llmTc.id);
        return execTc ?? llmTc;
      });

      entries.push({
        kind: 'llm_call',
        turnNumber: turn.turnNumber,
        modelLabel,
        durationMs: turn.response.durationMs,
        inputTokens: turn.response.inputTokens,
        outputTokens: turn.response.outputTokens,
        stopReason: turn.response.stopReason,
        systemTokens: turn.systemTokens,
        requestMessages: turn.requestMessages,
        thinking: turn.response.thinking,
        responseText: turn.response.text,
        toolCalls: turn.response.toolCalls,
        executedToolCalls,
        isStreaming: msg.isStreaming && i === details.length - 1,
      });
    }
  }

  return entries;
});

function getTurns(msg: ChatMessage): TurnDetail[] {
  if (msg.turnDetails && msg.turnDetails.length > 0) return msg.turnDetails;
  if (msg.thinking || msg.content || (msg.toolCalls && msg.toolCalls.length > 0)) {
    return [legacyTurnDetail(msg)];
  }
  return [];
}

function legacyTurnDetail(msg: ChatMessage): TurnDetail {
  return {
    turnNumber: msg.turnCount ?? 1,
    systemTokens: 0,
    requestMessages: [{ role: 'user', length: msg.content.length, preview: msg.content.slice(0, 200) }],
    response: {
      text: msg.content,
      thinking: msg.thinking || '',
      toolCalls: msg.toolCalls ?? [],
    },
  };
}

const systemPromptPreview = computed(() => {
  if (showFullSystemPrompt.value || props.systemPrompt.length <= SYSTEM_PROMPT_PREVIEW_LEN) {
    return props.systemPrompt;
  }
  return props.systemPrompt.slice(0, SYSTEM_PROMPT_PREVIEW_LEN) + '...';
});

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

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function toolSummary(tc: ToolCallContent): string {
  try {
    const args = JSON.parse(tc.arguments);
    switch (tc.name) {
      case 'bash': return `bash ${(args.command as string || '').slice(0, 60)}`;
      case 'write': return `write ${args.file_path || ''}`;
      case 'edit': return `edit ${args.file_path || ''}`;
      case 'read': return `read ${args.file_path || ''}`;
      case 'grep': return `grep ${args.pattern || ''}`;
      case 'glob': return `glob ${args.pattern || ''}`;
      case 'ls': return `ls ${args.path || ''}`;
      case 'subagent': return `subagent: ${args.agent || ''}`;
      default: return tc.name;
    }
  } catch { return tc.name; }
}
</script>

<template>
  <aside class="call-trace-panel">
    <div class="trace-header">
      <span class="trace-title">调用轨迹</span>
      <div class="trace-header-actions">
        <button
          v-if="traceFilePath"
          class="trace-folder-btn"
          title="在文件管理器中显示"
          @click="openTraceFolder"
        >
          📂
        </button>
        <button class="trace-close" @click="$emit('close')" title="关闭">×</button>
      </div>
    </div>

    <div v-if="traceFilePath" class="trace-path-bar">
      <span class="trace-path-label">当前会话文件</span>
      <span class="trace-path-value">{{ traceFilePath }}</span>
    </div>

    <div class="trace-body">
      <!-- System Prompt -->
      <details v-if="systemPrompt" class="trace-section">
        <summary class="trace-section-header">
          <span>系统提示词</span>
          <span class="trace-section-meta">{{ systemPrompt.length }} 字符</span>
        </summary>
        <pre class="trace-pre">{{ systemPromptPreview }}</pre>
        <button
          v-if="systemPrompt.length > SYSTEM_PROMPT_PREVIEW_LEN"
          class="trace-expand-btn"
          @click="showFullSystemPrompt = !showFullSystemPrompt"
        >
          {{ showFullSystemPrompt ? '收起' : `展开全文 (${systemPrompt.length} 字符)` }}
        </button>
      </details>

      <!-- Empty -->
      <div v-if="timeline.length === 0" class="trace-empty">
        暂无调用记录
      </div>

      <!-- Timeline -->
      <template v-for="(entry, ei) in timeline" :key="ei">
        <!-- ── 用户消息 ── -->
        <template v-if="entry.kind === 'user'">
          <div v-if="ei > 0" class="tl-connector" />
          <div class="tl-user-msg">
            <div class="tl-identity identity-user">[用户]</div>
            <div class="tl-user-text">{{ entry.content }}</div>
          </div>
        </template>

        <!-- ── LLM 调用 ── -->
        <template v-else-if="entry.kind === 'llm_call'">
          <div v-if="ei > 0" class="tl-connector" />

          <div class="tl-card" :class="{ 'tl-streaming': entry.isStreaming }">
            <!-- 身份标识 -->
            <div class="tl-identity identity-model">
              [模型] 第 {{ entry.turnNumber }} 次调用
              <span v-if="entry.modelLabel" class="tl-id-model">{{ entry.modelLabel }}</span>
              <span v-if="entry.durationMs" class="tl-id-dur">{{ formatDuration(entry.durationMs) }}</span>
              <span class="tl-id-tokens">↑{{ formatTokens(entry.inputTokens) }} ↓{{ formatTokens(entry.outputTokens) }}</span>
              <span v-if="entry.stopReason" class="tl-id-stop">{{ entry.stopReason }}</span>
              <span v-if="entry.isStreaming" class="tl-id-live">进行中</span>
            </div>

            <!-- 输入 -->
            <details class="tl-section">
              <summary class="tl-section-hd">
                <span>输入 · {{ entry.requestMessages.length }} 条消息</span>
                <span class="tl-section-meta">system ≈{{ formatTokens(entry.systemTokens) }}</span>
              </summary>
              <div class="tl-section-body">
                <div v-for="(rm, ri) in entry.requestMessages" :key="ri" class="tl-req-msg">
                  <div class="tl-req-role">{{ rm.role.toUpperCase() }} · {{ rm.length }} 字符</div>
                  <pre class="tl-req-preview">{{ rm.preview }}</pre>
                </div>
              </div>
            </details>

            <!-- 思考 -->
            <details
              v-if="entry.thinking"
              class="tl-section"
              :open="entry.isStreaming && !entry.toolCalls.length"
            >
              <summary class="tl-section-hd">
                <span>思考 · {{ entry.thinking.length }} 字符</span>
              </summary>
              <div class="tl-section-body tl-thinking">
                <StreamingText :text="entry.thinking" :is-streaming="false" />
              </div>
            </details>

            <!-- 工具调用 -->
            <div v-if="entry.toolCalls.length > 0" class="tl-tools-block">
              <div class="tl-identity identity-tool-call">
                [调用工具] {{ entry.toolCalls.length }} 个
              </div>
              <template v-for="tc in entry.executedToolCalls" :key="tc.id">
                <div class="tl-tool-item">
                  <SubagentCard v-if="tc.name === 'subagent'" :call="tc" />
                  <FileOperationCard v-else-if="tc.name === 'edit' || tc.name === 'write'" :call="tc" />
                  <CommandOperationCard v-else-if="tc.name === 'bash'" :call="tc" />
                  <FileInspectCard v-else-if="tc.name === 'read' || tc.name === 'glob' || tc.name === 'grep'" :call="tc" />
                  <details v-else class="tl-generic-tool">
                    <summary class="tl-generic-summary">
                      <span class="tl-generic-name">{{ tc.name }}</span>
                      <span class="tl-generic-summary-text">{{ toolSummary(tc) }}</span>
                      <span
                        class="tl-generic-status"
                        :class="{ 'tl-ok': tc.result?.success, 'tl-err': tc.result?.success === false }"
                      >
                        {{ tc.status === 'running' ? '执行中' : tc.result?.success === false ? '失败' : '完成' }}
                      </span>
                    </summary>
                    <div class="tl-generic-body">
                      <div class="tl-generic-field">
                        <span class="tl-field-label">参数</span>
                        <pre><code>{{ tc.arguments }}</code></pre>
                      </div>
                      <div v-if="tc.result" class="tl-generic-field">
                        <span class="tl-field-label">[工具返回]</span>
                        <pre :class="{ 'tl-err-text': tc.result.success === false }">{{
                          tc.result.error || tc.result.output || '无输出'
                        }}</pre>
                      </div>
                    </div>
                  </details>
                </div>
              </template>
            </div>

            <!-- 模型文本回复（无工具调用时） -->
            <div
              v-if="entry.responseText && entry.toolCalls.length === 0"
              class="tl-response"
            >
              <div class="tl-identity identity-response">[回复]</div>
              <StreamingText :text="entry.responseText" :is-streaming="entry.isStreaming" />
            </div>
          </div>
        </template>
      </template>
    </div>
  </aside>
</template>

<style scoped>
/* ── Panel chrome ── */
.call-trace-panel {
  display: flex; flex-direction: column;
  min-height: 0; height: 100%;
  background: var(--color-bg);
  border-left: 1px solid var(--border-color);
  overflow: hidden;
}

.trace-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 8px 0 12px; height: 38px; min-height: 38px;
  border-bottom: 1px solid var(--border-color);
  background: var(--color-bg-secondary); flex-shrink: 0;
}

.trace-title { font-size: 13px; font-weight: 600; color: var(--color-text); }

.trace-header-actions {
  display: flex; align-items: center; gap: 2px;
}

.trace-folder-btn {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  border: none; border-radius: 4px;
  background: transparent; color: var(--color-text-muted);
  cursor: pointer; font-size: 15px;
}
.trace-folder-btn:hover { background: var(--color-surface-hover); color: var(--color-accent); }

.trace-close {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  border: none; border-radius: 4px;
  background: transparent; color: var(--color-text-muted);
  cursor: pointer; font-size: 14px;
}
.trace-close:hover { background: var(--color-surface-hover); color: var(--color-text); }

.trace-path-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 12px; min-height: 26px; flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
  background: var(--color-bg-tertiary);
}

.trace-path-label {
  font-size: 10px; font-weight: 600; color: var(--color-text-muted);
  background: var(--color-surface); padding: 1px 6px; border-radius: 3px;
  flex-shrink: 0;
}

.trace-path-value {
  font-size: 10px; font-family: var(--font-mono);
  color: var(--color-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.trace-body {
  flex: 1; min-height: 0;
  overflow-y: auto; overflow-x: hidden;
  padding: 8px;
}

/* ── System prompt ── */
.trace-section {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  overflow: hidden; flex-shrink: 0; margin-bottom: 8px;
}

.trace-section-header {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; font-size: 12px;
  color: var(--color-text-secondary); cursor: pointer;
  background: var(--color-surface); user-select: none; list-style: none;
  transition: background 0.12s;
}
.trace-section-header::-webkit-details-marker { display: none; }
.trace-section-header::before {
  content: '▸';
  display: inline-block;
  font-size: 10px;
  color: var(--color-text-muted);
  transition: transform 0.15s;
  flex-shrink: 0;
  width: 12px;
  text-align: center;
}
details[open] > .trace-section-header::before {
  transform: rotate(90deg);
}
.trace-section-header:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.trace-section-meta { font-size: 10px; color: var(--color-text-muted); flex-shrink: 0; margin-left: auto; }

.trace-pre {
  margin: 0; padding: 8px 10px; font-size: 11px; line-height: 1.5;
  font-family: var(--font-mono); color: var(--color-text-secondary);
  white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto;
  background: var(--color-bg-tertiary); border-top: 1px solid var(--border-color);
}

.trace-expand-btn {
  display: block; width: 100%; padding: 5px 10px;
  border: none; border-top: 1px solid var(--border-color);
  background: var(--color-surface); color: var(--color-text-muted);
  font-size: 11px; cursor: pointer;
}
.trace-expand-btn:hover { color: var(--color-accent); }

/* ── Connector ── */
.tl-connector {
  height: 6px;
  margin-left: 20px;
  border-left: 2px solid var(--border-color);
}

/* ── Identity badges ── */
.tl-identity {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px;
  font-size: 11px; font-weight: 600;
  flex-wrap: wrap;
}

.identity-user {
  background: var(--color-bg-tertiary);
  color: var(--color-accent);
  border-radius: var(--border-radius-sm) var(--border-radius-sm) 0 0;
}

.identity-model {
  background: var(--color-surface);
  color: var(--color-text-secondary);
  border-bottom: 1px solid var(--border-color);
}

.identity-tool-call {
  background: var(--color-bg);
  color: var(--color-text-muted);
  font-size: 10px; text-transform: uppercase;
}

.identity-response {
  color: var(--color-text-muted);
  font-size: 10px; text-transform: uppercase;
  padding: 0 0 4px 0;
}

.tl-id-model {
  font-family: var(--font-mono); font-size: 10px;
  color: var(--color-text-muted); font-weight: 400;
}

.tl-id-dur {
  font-size: 10px; color: var(--color-text-muted); font-weight: 400;
  font-family: var(--font-mono);
}

.tl-id-tokens {
  font-size: 10px; color: var(--color-text-muted); font-weight: 400;
  font-family: var(--font-mono);
  background: var(--color-bg-tertiary);
  padding: 1px 4px; border-radius: 3px;
}

.tl-id-stop {
  font-size: 10px; color: var(--color-accent); font-weight: 400;
  border: 1px solid var(--border-color); border-radius: 3px;
  padding: 0 4px;
}

.tl-id-live {
  font-size: 10px; color: var(--color-accent); font-weight: 400;
  animation: pulse-text 1.5s ease-in-out infinite;
}

@keyframes pulse-text {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

/* ── User message ── */
.tl-user-msg {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  overflow: hidden;
  background: var(--color-bg-secondary);
}

.tl-user-text {
  padding: 6px 10px;
  font-size: 12px; line-height: 1.5;
  color: var(--color-text);
  white-space: pre-wrap; word-break: break-word;
}

/* ── Turn card ── */
.tl-card {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  overflow: hidden;
  background: var(--color-bg-secondary);
}
.tl-streaming { border-color: var(--color-accent); }

/* ── Sections ── */
.tl-section {
  border-bottom: 1px solid var(--border-color);
}

.tl-section-hd {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; font-size: 11px;
  color: var(--color-text-muted); cursor: pointer;
  user-select: none; list-style: none;
  transition: background 0.12s, color 0.12s;
  border-left: 3px solid transparent;
}
.tl-section-hd::-webkit-details-marker { display: none; }
.tl-section-hd::before {
  content: '▸';
  display: inline-block;
  font-size: 9px;
  color: var(--color-text-muted);
  transition: transform 0.15s;
  flex-shrink: 0;
  width: 10px;
  text-align: center;
}
details[open] > .tl-section-hd::before {
  transform: rotate(90deg);
}
.tl-section-hd:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
  border-left-color: var(--color-accent);
}

.tl-section-body {
  padding: 6px 10px;
  background: var(--color-bg-tertiary);
  border-top: 1px solid var(--border-color);
}

/* Request messages */
.tl-req-msg { margin-bottom: 6px; }
.tl-req-msg:last-child { margin-bottom: 0; }

.tl-req-role {
  font-size: 10px; font-weight: 600; color: var(--color-text-muted); margin-bottom: 2px;
}

.tl-req-preview {
  margin: 0; padding: 4px 6px; font-size: 10px; line-height: 1.4;
  font-family: var(--font-mono); color: var(--color-text-muted);
  white-space: pre-wrap; word-break: break-word;
  max-height: 100px; overflow-y: auto;
  background: var(--color-bg); border-radius: 3px;
  border: 1px solid var(--border-color);
}

/* Thinking */
.tl-thinking {
  font-size: 11px; line-height: 1.4; color: var(--color-text-muted);
  max-height: 300px; overflow-y: auto;
}

/* ── Tool calls ── */
.tl-tools-block {
  border-bottom: 1px solid var(--border-color);
}

.tl-tool-item {
  border-top: 1px solid var(--border-color);
}

/* Generic tool */
.tl-generic-tool { background: var(--color-surface); font-size: 12px; }

.tl-generic-summary {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 10px;
  cursor: pointer; user-select: none; list-style: none;
  transition: background 0.12s;
  border-left: 3px solid transparent;
}
.tl-generic-summary::-webkit-details-marker { display: none; }
.tl-generic-summary::before {
  content: '▸';
  display: inline-block;
  font-size: 9px;
  color: var(--color-text-muted);
  transition: transform 0.15s;
  flex-shrink: 0;
  width: 10px;
  text-align: center;
}
details[open] > .tl-generic-summary::before {
  transform: rotate(90deg);
}
.tl-generic-summary:hover {
  background: var(--color-surface-hover);
  border-left-color: var(--color-accent);
}

.tl-generic-name {
  font-family: var(--font-mono); font-size: 11px; font-weight: 600;
  color: var(--color-accent); flex-shrink: 0;
}

.tl-generic-summary-text {
  font-size: 11px; color: var(--color-text-secondary);
  font-family: var(--font-mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  min-width: 0;
}

.tl-generic-status {
  flex-shrink: 0; margin-left: auto;
  font-size: 10px; padding: 1px 5px; border-radius: 3px;
}
.tl-ok { color: var(--color-green); }
.tl-err { color: var(--color-red); }

.tl-generic-body {
  padding: 6px 10px;
  border-top: 1px solid var(--border-color);
  display: flex; flex-direction: column; gap: 6px;
}

.tl-generic-field {
  display: flex; flex-direction: column; gap: 2px;
}

.tl-field-label {
  font-size: 10px; color: var(--color-text-muted); text-transform: uppercase;
}

.tl-generic-field pre {
  margin: 0; padding: 4px 6px;
  background: var(--color-bg-secondary); border-radius: 4px;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--color-text-secondary);
  white-space: pre-wrap; word-break: break-word;
  max-height: 160px; overflow-y: auto;
}

.tl-err-text { color: var(--color-red) !important; }

/* ── Response ── */
.tl-response {
  padding: 6px 10px;
}

.tl-response :deep(.markdown-content) { font-size: 12px; line-height: 1.5; }
.tl-response :deep(.markdown-content p) { margin: 0 0 3px 0; }

/* Empty */
.trace-empty {
  text-align: center; padding: 32px 16px;
  font-size: 12px; color: var(--color-text-muted);
}
</style>
