<script setup lang="ts">
import type { SlashCommand } from '@shared/commands';
import { parseCommandFromInput } from '@shared/commands';
import type { GitInfo } from '@shared/types';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { bridge } from '../../api/bridge';
import { useDropdownGroup } from '../../composables/useDropdown';
import { useChatStore } from '../../stores/chat';
import { useSessionsStore } from '../../stores/sessions';
import { getChatInputClasses, getComposerTextareaHeight } from './chat-input';

const props = withDefaults(
  defineProps<{
    isStreaming: boolean;
    isEmptyConversation?: boolean;
  }>(),
  {
    isEmptyConversation: false,
  },
);

const emit = defineEmits<{
  send: [text: string];
  stop: [];
}>();

const sessionsStore = useSessionsStore();
const chatStore = useChatStore();

const inputText = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const _inputRef = ref<HTMLElement | null>(null);

// --- Slash Command Dropdown ---
const showCommandDropdown = ref(false);
const composerRect = ref<DOMRect | null>(null);

/** The currently recognized command name (for chip display). */
const activeCommandName = computed(() => {
  const text = inputText.value;
  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  const m = lastLine.match(/^\s*\/(\S+)/);
  if (!m) return null;
  const cmd = m[1];
  // Don't show chip for paths
  if (cmd.includes('/') || cmd.includes('\\')) return null;
  return cmd;
});

/** Detect whether the cursor is in a position where commands should be suggested. */
const commandQueryActive = computed(() => {
  const text = inputText.value;
  if (!text) return false;
  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  // Active if line starts with "/" followed by a word (not a path)
  const m = lastLine.match(/^\s*\/(\S*)/);
  if (!m) return false;
  const after = m[1];
  // Don't trigger on paths (contain / or \)
  if (after.includes('/') || after.includes('\\')) return false;
  return true;
});

function updateComposerRect(): void {
  const ta = textareaRef.value;
  if (ta) {
    composerRect.value = ta.getBoundingClientRect();
  }
}

function _onCommandSelect(cmd: SlashCommand): void {
  const text = inputText.value;
  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';

  // Replace "/..." with "/commandName "
  const replaced = lastLine.replace(/^(\s*)\/\S*/, `$1/${cmd.name}`);
  lines[lines.length - 1] = replaced + (cmd.argsLabel ? ` ${cmd.argsLabel} ` : ' ');
  inputText.value = lines.join('\n');

  showCommandDropdown.value = false;

  if (cmd.handler === 'local') {
    handleLocalCommand(cmd);
    return;
  }

  void nextTick(() => {
    textareaRef.value?.focus();
    const len = inputText.value.length;
    textareaRef.value?.setSelectionRange(len, len);
    resizeTextarea();
  });
}

function handleLocalCommand(cmd: SlashCommand): void {
  switch (cmd.name) {
    case 'clear':
      // Clear UI messages
      chatStore.clearMessages();
      // Clear worker + persisted messages for this session
      bridge.clearSessionMessages();
      inputText.value = '';
      void nextTick(() => resizeTextarea());
      break;
    case 'help':
      inputText.value = '/help';
      void nextTick(() => {
        resizeTextarea();
        textareaRef.value?.focus();
      });
      break;
  }
}

function closeCommandDropdown(): void {
  showCommandDropdown.value = false;
}

// Unified dropdown group: each dropdown keeps its own state but only one can be open.
const dropdowns = useDropdownGroup();
const _workspaceDropdown = dropdowns.register('workspace');
const _branchDropdown = dropdowns.register('branch');
const _modelDropdown = dropdowns.register('model');
const _permissionDropdown = dropdowns.register('permission');
const _thinkingDropdown = dropdowns.register('thinking');

const gitInfo = ref<GitInfo>({
  isRepo: false,
  addedLines: 0,
  deletedLines: 0,
  changedFiles: 0,
  stagedFiles: 0,
});

const activeSession = computed(() =>
  sessionsStore.sessions.find((s) => s.id === sessionsStore.activeSessionId),
);

const workspacePath = computed(() => activeSession.value?.workingDirectory || '');

async function refreshGitInfo() {
  const dir = workspacePath.value;
  if (!dir) {
    gitInfo.value = {
      isRepo: false,
      addedLines: 0,
      deletedLines: 0,
      changedFiles: 0,
      stagedFiles: 0,
    };
    return;
  }
  try {
    gitInfo.value = await bridge.getGitInfo(dir);
  } catch {
    gitInfo.value = {
      isRepo: false,
      addedLines: 0,
      deletedLines: 0,
      changedFiles: 0,
      stagedFiles: 0,
    };
  }
}

watch(() => activeSession.value?.workingDirectory, refreshGitInfo, { immediate: true });

// Show/hide command dropdown based on input
watch(commandQueryActive, (active) => {
  if (active) {
    updateComposerRect();
    showCommandDropdown.value = true;
  } else {
    showCommandDropdown.value = false;
  }
});

// Track input changes to update dropdown position
watch(inputText, () => {
  if (showCommandDropdown.value) {
    updateComposerRect();
  }
});

const _hasInput = computed(() => inputText.value.trim().length > 0);
const _isGoalInput = computed(() => inputText.value.trim().startsWith('/goal'));
const _chatInputClasses = computed(() => getChatInputClasses(props.isEmptyConversation));
const _placeholderText = computed(() =>
  props.isEmptyConversation
    ? '向 SunCode 提问，输入 @ 提及文件或子智能体，/ 使用命令，$ 使用技能，# 关联对话'
    : '提出后续修改要求',
);

function onDocumentClick(event: MouseEvent): void {
  // Only relevant when at least one dropdown is open
  if (!dropdowns.isAnyOpen.value) return;

  const target = event.target as Node;
  // Walk up ancestors to find if the click landed inside any .control-dropdown
  let el: Node | null = target;
  while (el && el !== document.body) {
    if (el instanceof HTMLElement && el.classList.contains('control-dropdown')) {
      return; // Clicked inside an open dropdown — let it handle itself
    }
    el = el.parentNode;
  }
  // Click was outside all dropdowns — close them
  dropdowns.closeAll();
}

function resizeTextarea(): void {
  const textarea = textareaRef.value;
  if (!textarea) return;

  textarea.style.height = 'auto';
  textarea.style.height = `${getComposerTextareaHeight(textarea.scrollHeight)}px`;
}

async function handleSend(): Promise<void> {
  const text = inputText.value.trim();
  if (!text) return;

  // Intercept local commands that shouldn't be sent to the worker
  const parsed = parseCommandFromInput(text);
  if (parsed?.command.handler === 'local') {
    handleLocalCommand(parsed.command);
    pushHistory(text);
    historyIndex = -1;
    draftBeforeHistory = '';
    inputText.value = '';
    await nextTick();
    if (textareaRef.value) {
      textareaRef.value.value = '';
      textareaRef.value.style.height = '64px';
    }
    return;
  }

  pushHistory(text);
  historyIndex = -1;
  draftBeforeHistory = '';

  emit('send', text);
  inputText.value = '';
  await nextTick();

  if (textareaRef.value) {
    textareaRef.value.value = '';
    textareaRef.value.style.height = '64px';
  }
}

// --- Input history (ArrowUp / ArrowDown cycling) ---
const HISTORY_MAX = 50;
const HISTORY_STORAGE_KEY = 'suncode:input-history';
const inputHistory: string[] = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) ?? '[]');
let historyIndex = -1;
// Saved draft so the user can return to what they typed after browsing history
let draftBeforeHistory = '';

function persistHistory(): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(inputHistory));
  } catch {
    /* quota exceeded — silently drop oldest entries */
  }
}

function pushHistory(text: string): void {
  // Deduplicate consecutive identical entries
  if (inputHistory.length > 0 && inputHistory[inputHistory.length - 1] === text) return;
  inputHistory.push(text);
  if (inputHistory.length > HISTORY_MAX) inputHistory.shift();
  persistHistory();
}

function navigateHistory(direction: 'up' | 'down'): void {
  if (inputHistory.length === 0) return;

  // Save current draft on first navigation
  if (historyIndex === -1) {
    draftBeforeHistory = inputText.value;
  }

  if (direction === 'up') {
    if (historyIndex < inputHistory.length - 1) {
      historyIndex++;
    }
  } else {
    if (historyIndex > 0) {
      historyIndex--;
    } else {
      // Return to the saved draft
      historyIndex = -1;
      inputText.value = draftBeforeHistory;
      return;
    }
  }

  inputText.value = inputHistory[inputHistory.length - 1 - historyIndex] ?? '';
}

function _handleKeydown(event: KeyboardEvent): void {
  // When command dropdown is open, let it handle navigation keys
  if (showCommandDropdown.value) {
    // If user typed a complete command (e.g. "/help"), let Enter pass through to send
    const isExactCommand = activeCommandName.value != null;
    if (event.key === 'Enter' && isExactCommand) {
      // Close dropdown and let Enter send the message naturally
      showCommandDropdown.value = false;
      // Continue to normal Enter handling below
    } else if (
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown' ||
      event.key === 'Enter' ||
      event.key === 'Tab'
    ) {
      return; // CommandDropdown handles navigation/selection
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeCommandDropdown();
      return;
    }
  }
  // ArrowUp from first line → history (backward)
  if (event.key === 'ArrowUp') {
    const ta = textareaRef.value;
    if (!ta) return;
    const cursorAtTop = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const noSelection = ta.selectionStart === ta.selectionEnd;
    const firstLine = ta.value.slice(0, ta.selectionStart).indexOf('\n') === -1;
    if (cursorAtTop || (noSelection && firstLine)) {
      event.preventDefault();
      navigateHistory('up');
      return;
    }
  }

  // ArrowDown from last line → history (forward)
  if (event.key === 'ArrowDown') {
    const ta = textareaRef.value;
    if (!ta) return;
    const textAfter = ta.value.slice(ta.selectionEnd ?? ta.value.length);
    const cursorAtBottom =
      ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;
    const lastLine = textAfter.indexOf('\n') === -1;
    if (cursorAtBottom || lastLine) {
      event.preventDefault();
      navigateHistory('down');
      return;
    }
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
}

function focusInput(): void {
  // Only steal focus when no dropdown is open, so keyboard/menu interactions
  // are not interrupted.
  if (dropdowns.isAnyOpen.value) return;
  textareaRef.value?.focus();
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  void refreshGitInfo();
  focusInput();
});
onUnmounted(() => document.removeEventListener('click', onDocumentClick));

// Refocus after the assistant finishes streaming so the user can keep typing.
watch(
  () => props.isStreaming,
  (streaming, wasStreaming) => {
    if (wasStreaming && !streaming) {
      void nextTick().then(focusInput);
    }
  },
);
</script>

<template>
  <div ref="inputRef" :class="chatInputClasses">
    <!-- Workspace info bar -->
    <WorkspaceSelector
      :git-info="gitInfo"
      :dropdown="workspaceDropdown"
      :branch-dropdown="branchDropdown"
      @branch-change="refreshGitInfo"
    />

    <div class="composer" :class="{ streaming: props.isStreaming }">
      <!-- Slash Command Dropdown (teleported to body) -->
      <CommandDropdown
        :input-text="inputText"
        :visible="showCommandDropdown"
        :anchor-rect="composerRect"
        @select="onCommandSelect"
        @close="closeCommandDropdown"
      />

      <!-- Command indicator chip -->
      <div v-if="activeCommandName" class="cmd-chip">
        <span class="cmd-chip-icon">/</span>
        <span class="cmd-chip-name">{{ activeCommandName }}</span>
      </div>

      <!-- Goal mode indicator -->
      <div v-if="isGoalInput" class="goal-indicator">
        <span class="goal-icon">🎯</span>
        <span class="goal-label">Goal 自主模式</span>
        <span class="goal-hint">系统将自动验证并重试直到目标完成</span>
      </div>
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="input-field"
        :placeholder="placeholderText"
        rows="1"
        @input="resizeTextarea"
        @keydown="handleKeydown"
      />

      <div class="composer-toolbar">
        <div class="toolbar-group toolbar-left">
          <button class="icon-btn add-btn" type="button" aria-label="添加上下文" disabled>
            <span aria-hidden="true">＋</span>
          </button>

          <PermissionSelector :dropdown="permissionDropdown" />
        </div>

        <div class="toolbar-group toolbar-right">
          <span
            class="status-indicator"
            :class="{ active: props.isStreaming }"
            aria-hidden="true"
          />

          <ModelSelector :is-streaming="props.isStreaming" :dropdown="modelDropdown" />
          <ThinkingSelector :dropdown="thinkingDropdown" />

          <!-- Stop button (visible during streaming) -->
          <button
            v-if="props.isStreaming"
            class="stop-btn"
            type="button"
            aria-label="停止生成"
            title="停止生成 (Esc)"
            @click="$emit('stop')"
          >
            <span aria-hidden="true">■</span>
          </button>

          <!-- Send / Queue button -->
          <button
            v-else
            class="send-btn"
            type="button"
            :disabled="!hasInput"
            aria-label="发送消息"
            @click="handleSend"
          >
            <span aria-hidden="true">↑</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-input {
  padding: 10px 20px 16px;
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.chat-input-empty {
  width: min(800px, calc(100% - 32px));
  margin: 0 auto;
  padding: 0;
  overflow: visible;
  border-radius: 20px;
  background: var(--color-bg-secondary);
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.2);
}

/* Workspace info bar */
.workspace-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  padding: 0 4px;
}

.workspace-folder {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.12s ease;
}

.workspace-folder:hover {
  border-color: var(--border-color-strong);
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.folder-icon {
  font-size: 14px;
  line-height: 1;
}

.workspace-name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.workspace-folder .chevron {
  font-size: 12px;
  color: var(--color-text-muted);
  transform: translateY(-1px);
}

.git-branch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--color-surface);
  color: var(--color-accent);
  font-size: 12px;
  font-family: var(--font-mono);
  font-weight: 600;
}

.branch-icon {
  font-size: 13px;
  line-height: 1;
  opacity: 0.8;
}

.composer {
  position: relative;
  width: 100%;
  padding: 14px 16px;
  overflow: visible;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  background: var(--color-bg);
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.04),
    0 4px 16px rgba(0, 0, 0, 0.06);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.chat-input-empty .composer {
  padding: 14px 16px;
  border-color: var(--border-color-strong);
  border-radius: 18px;
  background: var(--color-surface);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}

.composer:has(.goal-indicator) {
  border-color: color-mix(in srgb, var(--color-orange) 35%, var(--border-color-strong));
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.04),
    0 4px 16px color-mix(in srgb, var(--color-orange) 12%, transparent);
}

/* Command indicator chip */
.cmd-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px 10px;
  margin: -6px 0 8px 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-bg));
  border: 1px solid color-mix(in srgb, var(--color-accent) 25%, transparent);
  font-size: 12px;
  font-family: var(--font-mono);
}

.cmd-chip-icon {
  color: var(--color-accent);
  font-weight: 700;
  font-size: 13px;
}

.cmd-chip-name {
  color: var(--color-accent);
  font-weight: 600;
}

.goal-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  margin: -6px 0 8px 0;
  border-radius: var(--border-radius-sm);
  background: color-mix(in srgb, var(--color-orange) 10%, var(--color-bg));
  border: 1px solid color-mix(in srgb, var(--color-orange) 20%, transparent);
  font-size: 13px;
}

.goal-icon {
  font-size: 16px;
  line-height: 1;
}

.goal-label {
  font-weight: 700;
  color: var(--color-orange);
}

.goal-hint {
  color: var(--color-text-muted);
  font-size: 12px;
  margin-left: auto;
}

.composer:focus-within {
  border-color: color-mix(in srgb, var(--color-accent) 55%, var(--border-color-strong));
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.1),
    0 0 0 2px color-mix(in srgb, var(--color-accent) 10%, transparent);
}

.input-field {
  display: block;
  width: 100%;
  height: 64px;
  min-height: 64px;
  max-height: 200px;
  padding: 5px 2px 12px;
  resize: none;
  overflow-y: auto;
  border: 0;
  border-radius: 0;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.55;
  box-shadow: none;
}

.chat-input-empty .input-field {
  height: 62px;
  min-height: 62px;
  padding-top: 1px;
}

.input-field:focus {
  border: 0;
}

.input-field::placeholder {
  color: var(--color-text-muted);
  opacity: 0.76;
}

.composer-toolbar,
.toolbar-group {
  display: flex;
  align-items: center;
}

.composer-toolbar {
  min-width: 0;
  gap: 12px;
}

.toolbar-group {
  gap: 5px;
}

.toolbar-left {
  flex-shrink: 0;
}

.toolbar-right {
  min-width: 0;
  margin-left: auto;
}

.control-dropdown {
  position: relative;
  min-width: 0;
}

.icon-btn,
.toolbar-btn,
.send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
}

.chat-input-empty .send-btn {
  border-radius: 10px;
}

.chat-input-empty :deep(.workspace-bar) {
  margin: 0;
  padding: 13px 20px 10px;
}

.chat-input-empty :deep(.workspace-folder),
.chat-input-empty :deep(.git-branch) {
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 14px;
}

.chat-input-empty :deep(.workspace-folder:hover),
.chat-input-empty :deep(.git-branch:hover) {
  background: color-mix(in srgb, var(--color-surface-hover) 64%, transparent);
}

.icon-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  color: var(--color-text-secondary);
  font-size: 22px;
  font-weight: 300;
}

.icon-btn:disabled {
  cursor: default;
  opacity: 1;
}

.toolbar-btn {
  min-width: 0;
  height: 32px;
  gap: 6px;
  padding: 0 7px;
  color: var(--color-text-secondary);
  font-size: 13px;
  white-space: nowrap;
  transition:
    color 0.12s ease,
    background 0.12s ease;
}

.toolbar-btn:hover,
.control-dropdown.open .toolbar-btn {
  background: var(--color-surface);
  color: var(--color-text);
}

.permission-btn,
.permission-btn:hover,
.permission-dropdown.open .permission-btn {
  color: var(--color-orange);
}

.permission-icon,
.thinking-icon {
  font-size: 18px;
  line-height: 1;
}

.btn-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-btn .btn-label {
  max-width: 190px;
  color: var(--color-text);
}

.model-btn-disabled {
  opacity: 0.45;
  cursor: not-allowed !important;
}

.model-btn-disabled:hover {
  background: transparent !important;
}

.thinking-btn .btn-label {
  max-width: 54px;
  color: var(--color-text);
}

.chevron {
  color: var(--color-text-muted);
  font-size: 13px;
  transform: translateY(-1px);
}

.status-indicator {
  width: 17px;
  height: 17px;
  margin: 0 3px;
  flex-shrink: 0;
  border: 3px solid color-mix(in srgb, var(--color-text-muted) 35%, transparent);
  border-top-color: var(--color-text-muted);
  border-radius: 50%;
}

.status-indicator.active {
  border-top-color: var(--color-accent);
  animation: spin 0.8s linear infinite;
}

.send-btn {
  width: 36px;
  height: 36px;
  margin-left: 2px;
  padding: 0;
  flex-shrink: 0;
  border-radius: 12px;
  background: var(--color-accent);
  color: var(--color-bg);
  font-size: 22px;
  font-weight: 700;
  transition:
    background 0.15s ease,
    opacity 0.15s ease,
    transform 0.15s ease;
}

.send-btn:not(:disabled):hover {
  background: var(--color-accent-hover);
  transform: translateY(-1px);
}

.send-btn:disabled {
  cursor: default;
  background: var(--color-overlay);
  color: var(--color-bg);
  opacity: 0.62;
}

.send-btn.queued:not(:disabled) {
  background: var(--color-purple);
}

.stop-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-red);
  color: #fff;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.15s, opacity 0.15s;
}
.stop-btn:hover {
  opacity: 0.85;
}

.dropdown-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  min-width: 190px;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border-color-strong);
  border-radius: 14px;
  background: var(--color-bg);
  box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.2);
  z-index: 100;
}

.model-menu {
  right: 0;
  left: auto;
  min-width: 250px;
}

.thinking-menu {
  right: 0;
  left: auto;
  min-width: 150px;
}

.permission-menu {
  min-width: 220px;
}

.folder-menu {
  min-width: 320px;
  max-width: 500px;
}

.folder-menu .item-folder-icon {
  width: 18px;
  flex-shrink: 0;
  font-size: 14px;
  text-align: center;
}

.folder-menu .item-desc {
  font-size: 10px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 380px;
}

.dropdown-divider {
  height: 1px;
  margin: 4px 8px;
  background: var(--border-color);
}

.pick-folder-item .item-icon-pick {
  width: 18px;
  flex-shrink: 0;
  font-size: 16px;
  font-weight: 300;
  text-align: center;
  color: var(--color-accent);
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 11px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  text-align: left;
  transition:
    background 0.08s ease,
    color 0.08s ease;
}

.dropdown-item:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.dropdown-item.active {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent);
  font-weight: 550;
}

.item-icon {
  width: 18px;
  flex-shrink: 0;
  color: var(--color-orange);
  font-size: 14px;
  text-align: center;
}

.item-info {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.item-label {
  white-space: nowrap;
}

.item-desc,
.item-provider,
.item-hint {
  color: var(--color-text-muted);
  font-size: 10px;
}

.item-provider,
.item-hint {
  margin-left: auto;
}

.item-provider {
  text-transform: uppercase;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 720px) {
  .chat-input {
    padding-right: 12px;
    padding-left: 12px;
  }

  .chat-input-empty {
    width: calc(100% - 20px);
    padding: 0;
  }

  .composer {
    padding-right: 10px;
    padding-left: 12px;
  }

  .composer-toolbar {
    gap: 5px;
  }

  .toolbar-group {
    gap: 1px;
  }

  .model-btn .btn-label {
    max-width: 105px;
  }

  .permission-btn .btn-label {
    max-width: 82px;
  }

  .status-indicator {
    display: none;
  }
}

@media (max-width: 540px) {
  .permission-btn .btn-label,
  .thinking-icon {
    display: none;
  }

  .model-btn .btn-label {
    max-width: 82px;
  }
}
</style>
