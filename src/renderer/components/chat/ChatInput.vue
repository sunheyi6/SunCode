<script setup lang="ts">
import {
  BUILTIN_COMMANDS,
  createSkillCommands,
  findCommand,
  parseCommandFromInput,
  type SlashCommand,
} from '@shared/commands';
import type { DiscoveredSkill, GitInfo } from '@shared/types';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { bridge } from '../../api/bridge';
import { useDropdownGroup } from '../../composables/useDropdown';
import { useChatStore } from '../../stores/chat';
import { useSessionsStore } from '../../stores/sessions';
import { useSettingsStore } from '../../stores/settings';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';
import CommandDropdown from './CommandDropdown.vue';
import {
  COLLAPSED_TEXTAREA_HEIGHT,
  chatInputSessionDrafts,
  getChatInputClasses,
  getComposerTextareaHeight,
  isInsideControlDropdown,
  syncChatInputDropdownBodyClass,
} from './chat-input';
import ModelSelector from './ModelSelector.vue';
import PermissionSelector from './PermissionSelector.vue';
import ThinkingSelector from './ThinkingSelector.vue';
import WorkspaceSelector from './WorkspaceSelector.vue';

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
const settingsStore = useSettingsStore();

const inputText = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const inputRef = ref<HTMLElement | null>(null);
const inputExpanded = ref(false);

const isInputLong = computed(() => {
  const text = inputText.value;
  const lineCount = text.split('\n').length;
  return lineCount > 5 || text.length > 400;
});

const isInputCollapsed = computed(() => isInputLong.value && !inputExpanded.value);

function toggleInputExpand() {
  inputExpanded.value = !inputExpanded.value;
  void nextTick(() => resizeTextarea());
}

// --- Slash Command Dropdown ---
const showCommandDropdown = ref(false);
const composerRect = ref<DOMRect | null>(null);
const discoveredSkills = ref<DiscoveredSkill[]>([]);
const COMMAND_INPUT_SPACER = '   ';
const availableCommands = computed(() => [
  ...BUILTIN_COMMANDS,
  ...createSkillCommands(discoveredSkills.value, settingsStore.settings.disabledSkills),
]);

/** The currently recognized command for the compact command-match display. */
const activeCommand = computed(() => {
  const text = inputText.value;
  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  const m = lastLine.match(/^\s*\/(\S+)/);
  if (!m) return undefined;
  const cmd = m[1];
  // Don't show chip for paths
  if (cmd.includes('/') || cmd.includes('\\')) return undefined;
  return findCommand(cmd, availableCommands.value);
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

async function loadSkillCommands(): Promise<void> {
  try {
    discoveredSkills.value = await bridge.getSkills();
  } catch (error) {
    console.error('Failed to load skill commands:', error);
    discoveredSkills.value = [];
  }
}

function onCommandSelect(cmd: SlashCommand): void {
  const text = inputText.value;
  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';

  // Replace "/..." with "/commandName "
  const replaced = lastLine.replace(/^(\s*)\/\S*/, `$1/${cmd.name}`);
  // Reserve visual space for the icon + display label, then place the cursor
  // after it so subsequently typed text is never covered by the command overlay.
  lines[lines.length - 1] = `${replaced}${COMMAND_INPUT_SPACER}`;
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
const workspaceDropdown = dropdowns.register('workspace');
const branchDropdown = dropdowns.register('branch');
const modelDropdown = dropdowns.register('model');
const permissionDropdown = dropdowns.register('permission');
const thinkingDropdown = dropdowns.register('thinking');

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
  chatInputSessionDrafts.save(sessionsStore.activeSessionId, inputText.value);
  if (showCommandDropdown.value) {
    updateComposerRect();
  }
});

const hasInput = computed(() => inputText.value.trim().length > 0);
const chatInputClasses = computed(() => getChatInputClasses(props.isEmptyConversation));
const placeholderText = computed(() =>
  props.isEmptyConversation
    ? '向 SunCode 提问，输入 @ 提及文件或子智能体，/ 使用命令，$ 使用技能，# 关联对话'
    : '提出后续修改要求',
);

function onDocumentPointerDown(event: PointerEvent): void {
  // Only relevant when at least one dropdown is open
  if (!dropdowns.isAnyOpen.value) return;

  if (isInsideControlDropdown(event.target)) return;

  dropdowns.closeAll();
}

function resizeTextarea(): void {
  const textarea = textareaRef.value;
  if (!textarea) return;

  if (isInputCollapsed.value) {
    textarea.style.height = `${COLLAPSED_TEXTAREA_HEIGHT}px`;
    return;
  }

  textarea.style.height = 'auto';
  textarea.style.height = `${getComposerTextareaHeight(textarea.scrollHeight)}px`;
}

function resetInputState(text: string): void {
  inputText.value = text;
  historyIndex = -1;
  draftBeforeHistory = '';
  inputExpanded.value = false;
  void nextTick(() => resizeTextarea());
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
    inputExpanded.value = false;
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
  inputExpanded.value = false;
}

// --- Input history (ArrowUp / ArrowDown cycling) ---
const HISTORY_MAX = 50;
const HISTORY_STORAGE_KEY = 'suncode:input-history';
const inputHistory: string[] = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) ?? '[]');
let historyIndex = -1;
// Saved draft so the user can return to what they typed after browsing history
let draftBeforeHistory = '';

watch(
  () => sessionsStore.activeSessionId,
  (sessionId, previousSessionId) => {
    chatInputSessionDrafts.save(previousSessionId, inputText.value);
    resetInputState(chatInputSessionDrafts.load(sessionId));
  },
  { immediate: true },
);

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

function handleKeydown(event: KeyboardEvent): void {
  // When command dropdown is open, let it handle navigation keys
  if (showCommandDropdown.value) {
    // If user typed a complete command (e.g. "/help"), let Enter pass through to send
    const isExactCommand = activeCommand.value != null;
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
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  void refreshGitInfo();
  void loadSkillCommands();
  focusInput();
});
onUnmounted(() => {
  chatInputSessionDrafts.save(sessionsStore.activeSessionId, inputText.value);
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  syncChatInputDropdownBodyClass(false, document.body.classList);
});

watch(
  dropdowns.isAnyOpen,
  (isOpen) => {
    syncChatInputDropdownBodyClass(isOpen, document.body.classList);
  },
  { immediate: true },
);

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
    <!-- Workspace info bar (only shown before conversation starts) -->
    <WorkspaceSelector
      v-if="isEmptyConversation"
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
        :commands="availableCommands"
        @select="onCommandSelect"
        @close="closeCommandDropdown"
      />

      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="input-field"
        :class="{ collapsed: isInputCollapsed }"
        :placeholder="placeholderText"
        rows="1"
        @input="resizeTextarea"
        @keydown="handleKeydown"
      />
      <span
        v-if="activeCommand"
        class="cmd-inline-match"
        :style="{ minWidth: `${activeCommand.name.length + 1}ch` }"
        aria-hidden="true"
      >
        <AppIcon :name="activeCommand.icon" :size="14" />
        {{ activeCommand.label ?? activeCommand.name }}
      </span>

      <button
        v-if="isInputLong"
        class="input-expand-btn"
        @click="toggleInputExpand"
      >
        <AppIcon :name="inputExpanded ? 'chevron-up' : 'chevron-down'" :size="13" />
        {{ inputExpanded ? '收起' : '展开更多' }}
      </button>

      <div class="composer-toolbar">
        <div class="toolbar-group toolbar-left">
          <button class="icon-btn add-btn" type="button" aria-label="添加上下文" disabled>
            <span aria-hidden="true"><AppIcon name="plus" :size="15" /></span>
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
            <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect x="4" y="4" width="16" height="16" rx="4" />
              </svg>
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
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M12 19V5" />
                <path d="M5 12l7-7 7 7" />
              </svg>
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
  border-radius: var(--border-radius-xl);
  background: var(--color-bg-secondary);
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
  border-radius: var(--border-radius-lg);
  background: var(--color-bg);
  box-shadow: var(--shadow-sm);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.chat-input-empty .composer {
  padding: 14px 16px;
  border-color: var(--border-color-strong);
  border-radius: var(--border-radius-xl);
  background: var(--color-surface);
  box-shadow: var(--shadow-md);
}

/* Overlay only the command text in its original input line. */
.cmd-inline-match {
  position: absolute;
  z-index: 2;
  top: 18px;
  left: 17px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: 0;
  background: var(--color-bg);
  color: var(--color-accent);
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: inherit;
  line-height: 1.55;
  pointer-events: none;
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

.input-field.collapsed {
  max-height: 120px;
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

.input-expand-btn {
  display: block;
  margin: -4px 0 8px;
  padding: 2px 8px;
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  cursor: pointer;
  font-size: 11px;
  color: var(--color-text-muted);
  transition: all 0.12s ease;
}

.input-expand-btn:hover {
  background: color-mix(in srgb, var(--color-text-muted) 10%, transparent);
  color: var(--color-text);
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

:global(body.chat-input-dropdown-open .welcome-empty) {
  -webkit-app-region: no-drag;
  app-region: no-drag;
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
  border-radius: 50%;
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
  width: 34px;
  height: 34px;
  padding: 0;
  color: var(--color-text-secondary);
  font-size: 16px;
  font-weight: 300;
}

.icon-btn:disabled {
  cursor: default;
  opacity: 1;
}

.toolbar-btn {
  min-width: 0;
  height: 34px;
  gap: 6px;
  padding: 0 7px;
  border-radius: var(--border-radius-pill);
  color: var(--color-text-secondary);
  font-size: 14px;
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
  font-size: 14px;
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
  font-size: 12px;
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
    width: 34px;
    height: 34px;
    margin-left: 2px;
    padding: 0;
    flex-shrink: 0;
    border: 0;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--color-accent) 0%, color-mix(in srgb, var(--color-accent) 85%, #000) 100%);
    color: var(--color-bg);
    cursor: pointer;
    box-shadow: 0 2px 10px color-mix(in srgb, var(--color-accent) 25%, transparent);
    transition:
      background 0.2s ease,
      opacity 0.2s ease,
      transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
      box-shadow 0.2s ease;
  }

  .send-btn:not(:disabled):hover {
    background: linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 90%, #000) 0%, var(--color-accent) 100%);
    transform: translateY(-2px) scale(1.06);
    box-shadow: 0 4px 18px color-mix(in srgb, var(--color-accent) 35%, transparent);
  }

  .send-btn:not(:disabled):active {
    transform: translateY(0) scale(0.94);
  }

  .send-btn:disabled {
    cursor: default;
    background: var(--color-overlay);
    color: var(--color-bg);
    opacity: 0.55;
    box-shadow: none;
  }

  .send-btn.queued:not(:disabled) {
    background: linear-gradient(135deg, var(--color-purple) 0%, color-mix(in srgb, var(--color-purple) 85%, #000) 100%);
    box-shadow: 0 2px 10px color-mix(in srgb, var(--color-purple) 25%, transparent);
  }

  .stop-btn {
    width: 34px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #1a1a1a 0%, #000 100%);
    color: #fff;
    border: 0;
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 2px 10px color-mix(in srgb, #000 25%, transparent);
    transition:
      background 0.2s ease,
      transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
      opacity 0.2s ease,
      box-shadow 0.2s ease;
  }

  .stop-btn:hover {
    opacity: 0.9;
    transform: scale(1.06);
    box-shadow: 0 4px 18px color-mix(in srgb, #000 35%, transparent);
  }

  .stop-btn:active {
    transform: scale(0.94);
  }

.dropdown-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  min-width: 190px;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border-color-strong);
  border-radius: var(--border-radius-lg);
  background: var(--color-bg);
  box-shadow: var(--shadow-lg);
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
