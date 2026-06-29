<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChatMessage, ChatMessageBlock } from '../../stores/chat';
import CompactToolBar from '../tools/CompactToolBar.vue';
import ToolOperationList from '../tools/ToolOperationList.vue';
import StreamingText from './StreamingText.vue';
import CommandOperationCard from '../tools/CommandOperationCard.vue';
import FileOperationCard from '../tools/FileOperationCard.vue';
import FileInspectCard from '../tools/FileInspectCard.vue';
import SubagentCard from '../tools/SubagentCard.vue';

const props = defineProps<{
  message: ChatMessage;
}>();

const hasContent = computed(() => props.message.content.length > 0);
const hasToolCalls = computed(() => (props.message.toolCalls?.length ?? 0) > 0);
const hasThinking = computed(
  () => props.message.isStreaming || Boolean(props.message.thinking) || hasToolCalls.value,
);

const thinkingText = computed(() => props.message.thinking || '');

const copied = ref(false);

// -- elapsed time --
const elapsedSeconds = ref(0);
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

function startElapsedTimer(): void {
  stopElapsedTimer();
  elapsedSeconds.value = Math.round((Date.now() - props.message.timestamp) / 1000);
  elapsedTimer = setInterval(() => {
    elapsedSeconds.value = Math.round((Date.now() - props.message.timestamp) / 1000);
  }, 1000);
}

function stopElapsedTimer(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

watch(
  () => props.message.isStreaming,
  (streaming) => {
    if (streaming) startElapsedTimer();
    else {
      elapsedSeconds.value = Math.round((Date.now() - props.message.timestamp) / 1000);
      stopElapsedTimer();
    }
  },
  { immediate: true },
);

onMounted(() => {
  if (props.message.isStreaming) startElapsedTimer();
});
onBeforeUnmount(() => {
  stopElapsedTimer();
});

const formattedElapsed = computed(() => {
  const s = elapsedSeconds.value;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remain = s % 60;
  return remain > 0 ? `${m}m${remain}s` : `${m}m`;
});

const timeLabel = computed(() => {
  const d = new Date(props.message.timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
});

const fullTextForCopy = computed(() => {
  const parts: string[] = [];
  if (props.message.thinking) parts.push(props.message.thinking);
  if (props.message.content) parts.push(props.message.content);
  return parts.join('\n\n');
});

const thinkingSummary = computed(() => {
  const calls = props.message.toolCalls ?? [];
  const running = calls.find((t) => t.status === 'running');
  const done = calls.filter((t) => t.status === 'done' || t.status === 'error').length;
  const time = formattedElapsed.value;

  if (props.message.isStreaming) {
    if (running) {
      const shortArgs = running.arguments ? running.arguments.slice(0, 50) : '';
      return `[${running.name}] ${shortArgs}  ${time}`;
    }
    if (done > 0) return `[工具] ${done}/${calls.length} 完成  ${time}`;
    return `[等待响应] ${time}`;
  }

  const parts: string[] = ['思考过程'];
  const turn = props.message.turnCount ?? 0;
  if (turn > 0) parts.push(`${turn}次请求`);
  if (elapsedSeconds.value > 0) parts.push(time);
  if (calls.length > 0) {
    const names = calls
      .slice(0, 3)
      .map((t) => t.name)
      .join(', ');
    const more = calls.length > 3 ? ` +${calls.length - 3}` : '';
    parts.push(names + more);
  }
  return parts.join('  ');
});

const hasAnyThinkingContent = computed(() => {
  return thinkingText.value.length > 0 || hasToolCalls.value;
});

const hasBlocks = computed(() => (props.message.blocks?.length ?? 0) > 0);

const blocksCount = computed(() => props.message.blocks?.length ?? 0);

const currentBlockIndex = computed(() => {
  if (!hasBlocks.value || !props.message.isStreaming) return -1;
  return blocksCount.value - 1;
});

function getBlockSummary(block: ChatMessageBlock): string {
  if (block.type === 'thinking') {
    const text = block.thinking || '';
    return text.length > 50 ? text.slice(0, 50) + '...' : text;
  }
  if (block.type === 'tool_call' && block.toolCall) {
    return `${block.toolCall.name}`;
  }
  return '未知';
}

function isInspectTool(name: string): boolean {
  return name === 'read' || name === 'glob' || name === 'grep';
}

function getToolIcon(name: string): string {
  switch (name) {
    case 'bash': return '⚙';
    case 'read': return '📖';
    case 'glob': return '🔍';
    case 'grep': return '🔎';
    case 'edit': return '✏';
    case 'write': return '📝';
    case 'subagent': return '🤖';
    default: return '📦';
  }
}

function getToolLabel(name: string): string {
  switch (name) {
    case 'bash': return '运行命令';
    case 'read': return '读取';
    case 'glob': return '查找';
    case 'grep': return '搜索';
    case 'edit': return '编辑';
    case 'write': return '写入';
    case 'subagent': return '子代理';
    default: return name;
  }
}

async function copyContent() {
  try {
    await navigator.clipboard.writeText(fullTextForCopy.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = fullTextForCopy.value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  }
}
</script>

<template>
  <div class="assistant-message">
    <div class="message-body">
      <!-- Streaming: show blocks with previous ones collapsed, current one expanded -->
      <div v-if="hasThinking && message.isStreaming" class="thinking-live">
        <div class="thinking-live-header">
          <span class="thinking-live-dot" />
          <span>{{ thinkingSummary }}</span>
        </div>
        <div v-if="hasBlocks" class="thinking-blocks">
          <template v-for="(block, index) in message.blocks" :key="block.id">
            <!-- Previous blocks: collapsed -->
            <details v-if="index < currentBlockIndex" class="block-collapsed">
              <summary class="block-summary">
                <span class="block-icon">{{ block.type === 'thinking' ? '💭' : '⚙' }}</span>
                <span class="block-type">{{ block.type === 'thinking' ? '思考' : '工具调用' }}</span>
                <span class="block-preview">{{ getBlockSummary(block) }}</span>
              </summary>
              <div class="block-content">
                <div v-if="block.type === 'thinking'" class="thinking-text">
                  {{ block.thinking }}
                </div>
                <div v-else-if="block.type === 'tool_call' && block.toolCall">
                  <SubagentCard v-if="block.toolCall.name === 'subagent'" :call="block.toolCall" />
                  <FileOperationCard v-else-if="block.toolCall.name === 'edit' || block.toolCall.name === 'write'" :call="block.toolCall" />
                  <CommandOperationCard v-else-if="block.toolCall.name === 'bash'" :call="block.toolCall" />
                  <FileInspectCard v-else-if="isInspectTool(block.toolCall.name)" :call="block.toolCall" />
                </div>
              </div>
            </details>

            <!-- Current block: expanded -->
            <div v-else-if="index === currentBlockIndex" class="block-current">
              <div class="block-header">
                <span class="block-icon">{{ block.type === 'thinking' ? '💭' : '⚙' }}</span>
                <span class="block-type">{{ block.type === 'thinking' ? '思考' : '工具调用' }}</span>
              </div>
              <div v-if="block.type === 'thinking'" class="thinking-text">
                {{ block.thinking }}
              </div>
              <div v-else-if="block.type === 'tool_call' && block.toolCall">
                <div class="tool-call-header">
                  <span class="tool-icon">{{ getToolIcon(block.toolCall.name) }}</span>
                  <span class="tool-label">{{ getToolLabel(block.toolCall.name) }}</span>
                  <span class="tool-name">Thought</span>
                </div>
                <SubagentCard v-if="block.toolCall.name === 'subagent'" :call="block.toolCall" />
                <FileOperationCard v-else-if="block.toolCall.name === 'edit' || block.toolCall.name === 'write'" :call="block.toolCall" />
                <CommandOperationCard v-else-if="block.toolCall.name === 'bash'" :call="block.toolCall" />
                <FileInspectCard v-else-if="isInspectTool(block.toolCall.name)" :call="block.toolCall" />
              </div>
            </div>
          </template>
        </div>
        <div v-else-if="thinkingText" class="thinking-text">
          {{ thinkingText }}
        </div>
        <ToolOperationList
          v-else-if="hasToolCalls"
          :calls="message.toolCalls ?? []"
        />
      </div>

      <!-- Done: all blocks collapsed -->
      <details v-if="!message.isStreaming && hasAnyThinkingContent" class="thinking-section">
        <summary class="thinking-summary thinking-summary-done">{{ thinkingSummary }}</summary>
        <div class="thinking-content">
          <div v-if="hasBlocks" class="thinking-blocks">
            <template v-for="block in message.blocks" :key="block.id">
              <details class="block-collapsed">
                <summary class="block-summary">
                  <span class="block-icon">{{ block.type === 'thinking' ? '💭' : '⚙' }}</span>
                  <span class="block-type">{{ block.type === 'thinking' ? '思考' : '工具调用' }}</span>
                  <span class="block-preview">{{ getBlockSummary(block) }}</span>
                </summary>
                <div class="block-content">
                  <div v-if="block.type === 'thinking'" class="thinking-text">
                    {{ block.thinking }}
                  </div>
                  <div v-else-if="block.type === 'tool_call' && block.toolCall">
                    <SubagentCard v-if="block.toolCall.name === 'subagent'" :call="block.toolCall" />
                    <FileOperationCard v-else-if="block.toolCall.name === 'edit' || block.toolCall.name === 'write'" :call="block.toolCall" />
                    <CommandOperationCard v-else-if="block.toolCall.name === 'bash'" :call="block.toolCall" />
                    <FileInspectCard v-else-if="isInspectTool(block.toolCall.name)" :call="block.toolCall" />
                  </div>
                </div>
              </details>
            </template>
          </div>
          <div v-else-if="thinkingText" class="thinking-text">
            {{ thinkingText }}
          </div>
          <ToolOperationList
            v-else-if="hasToolCalls"
            :calls="message.toolCalls ?? []"
          />
          <div v-else-if="!thinkingText" class="thinking-no-tools">无工具调用</div>
        </div>
      </details>

      <!-- Visible reply text -->
      <div v-if="hasContent" class="message-content" :class="{ streaming: message.isStreaming }">
        <StreamingText :text="message.content" :is-streaming="message.isStreaming" />
      </div>

      <!-- Waiting for first response -->
      <div v-if="message.isStreaming && !hasContent && !hasThinking" class="streaming-indicator">
        <span class="dot" /><span class="dot" /><span class="dot" />
      </div>
    </div>
    <div v-if="!message.isStreaming" class="message-footer">
      <span class="message-time">{{ timeLabel }}</span>
      <button class="copy-btn" :class="{ copied }" title="复制回复" @click="copyContent">
        {{ copied ? '已复制' : '复制' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.assistant-message {
  display: flex; flex-direction: column; align-items: flex-start;
  padding: var(--spacing-sm) var(--spacing-xl);
}
.message-body { max-width: 90%; }

/* -- streaming live -- */
.thinking-live {
  margin-bottom: var(--spacing-sm);
  border-radius: var(--border-radius);
  overflow: hidden;
  background: var(--color-bg-tertiary);
}

.thinking-live-header {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--color-text-secondary);
  padding: 6px 12px;
  background: var(--color-surface);
}

.thinking-live-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-accent);
  animation: pulse-dot 1.4s ease-in-out infinite;
}

@keyframes pulse-dot { 0%,100%{opacity:.4} 50%{opacity:1} }

/* -- thinking section -- */
.thinking-section {
  margin-bottom: var(--spacing-sm);
  border-radius: var(--border-radius);
  overflow: hidden;
  background: var(--color-bg-tertiary);
}

.thinking-summary {
  padding: 6px 12px; font-size: 12px; color: var(--color-text-secondary);
  cursor: pointer; background: var(--color-surface); user-select: none;
  list-style: none;
}
.thinking-summary::-webkit-details-marker { display: none; }
.thinking-summary::before {
  content: '>'; display: inline-block; margin-right: 6px;
  font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted);
  transition: transform 0.15s;
}
details[open] > .thinking-summary::before { transform: rotate(90deg); }
.thinking-summary:hover { background: var(--color-surface-hover); }

.thinking-summary-done {
  cursor: pointer;
  opacity: 0.6;
}
.thinking-summary-done::before {
  content: '>';
  display: inline-block;
  margin-right: 6px;
  font-size: 10px;
  color: var(--color-text-muted);
  transition: transform 0.15s;
}
details[open] > .thinking-summary-done::before {
  content: '>'; transform: rotate(90deg);
  color: var(--color-text-muted);
}

.thinking-content {
  padding: 0;
  color: var(--color-text-secondary);
  max-height: 600px; overflow-y: auto;
}

.thinking-text {
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-secondary);
  background: var(--color-bg);
  border-left: 3px solid var(--color-accent);
}

.thinking-blocks {
  padding: 4px 0;
}

.block-collapsed {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  margin: 2px 0;
  font-size: 12px;
}

.block-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  cursor: pointer;
  user-select: none;
  list-style: none;
  font-size: 11px;
}

.block-summary::-webkit-details-marker {
  display: none;
}

.block-summary::before {
  content: '▸';
  font-size: 10px;
  color: var(--color-text-muted);
  transition: transform 0.15s;
}

details[open] > .block-summary::before {
  transform: rotate(90deg);
}

.block-icon {
  font-size: 12px;
}

.block-type {
  font-size: 11px;
  color: var(--color-text-muted);
}

.block-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
}

.block-content {
  padding: 4px 8px;
  border-top: 1px solid var(--border-color);
}

.block-current {
  margin: 4px 0;
  padding: 4px 0;
}

.block-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  border-radius: var(--border-radius-sm);
}

.tool-call-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.tool-icon {
  font-size: 12px;
}

.tool-label {
  font-size: 11px;
}

.tool-name {
  font-size: 11px;
  font-style: italic;
}

.thinking-no-tools {
  font-size: 11px; color: var(--color-text-muted); font-style: italic;
  padding: 4px 12px;
}

/* -- reply text -- */
.message-content { font-size: 14px; line-height: 1.6; color: var(--color-text); }

.message-content.streaming {
  color: var(--color-text-secondary); font-size: 13px; line-height: 1.5;
  padding: 4px 0; border-left: 2px solid var(--color-accent);
  padding-left: 10px; margin: 4px 0;
}
/* -- waiting dots -- */
.streaming-indicator { display: flex; gap: 4px; padding: 8px 0; }

.dot {
  width: 6px; height: 6px; background: var(--color-text-muted);
  border-radius: 50%; animation: pulse 1.4s ease-in-out infinite both;
}
.dot:nth-child(2) { animation-delay: 0.16s; }
.dot:nth-child(3) { animation-delay: 0.32s; }

@keyframes pulse { 0%,80%,100%{opacity:.3;transform:scale(.8)} 40%{opacity:1;transform:scale(1)} }

/* -- footer -- */
.message-footer { display: flex; align-items: center; gap: 4px; margin-top: 2px; padding-left: 4px; }
.message-time { font-size: 11px; color: var(--color-text-muted); }

.copy-btn {
  padding: 1px 4px; background: none; border: none; cursor: pointer;
  font-size: 12px; opacity: 0; transition: opacity 0.15s;
  color: var(--color-text-muted); border-radius: 4px;
}
.assistant-message:hover .copy-btn { opacity: 0.7; }
.copy-btn:hover { opacity: 1 !important; background: var(--color-surface); }
.copy-btn.copied { opacity: 1; color: var(--color-green); font-size: 11px; }
</style>
