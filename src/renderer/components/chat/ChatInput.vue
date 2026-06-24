<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useModelsStore } from '../../stores/models';
import { useSettingsStore } from '../../stores/settings';
import { getComposerTextareaHeight } from './chat-input';

const props = defineProps<{
  isStreaming: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
  stop: [];
}>();

const modelsStore = useModelsStore();
const settingsStore = useSettingsStore();

const inputText = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const inputRef = ref<HTMLElement | null>(null);
const modelOpen = ref(false);
const thinkingOpen = ref(false);
const permOpen = ref(false);

const hasInput = computed(() => inputText.value.trim().length > 0);
const availableModels = computed(() => modelsStore.recommendedModels);
const currentModelLabel = computed(() => {
  const model = availableModels.value.find(
    (option) =>
      option.model === modelsStore.activeModel && option.provider === modelsStore.activeProvider,
  );
  return model?.label ?? `${modelsStore.activeProvider}/${modelsStore.activeModel}`;
});

const thinkingLevels = [
  { value: 'minimal' as const, label: '最小' },
  { value: 'low' as const, label: '低' },
  { value: 'medium' as const, label: '中' },
  { value: 'high' as const, label: '高' },
  { value: 'xhigh' as const, label: '最高' },
];

const currentThinking = computed(
  () =>
    thinkingLevels.find((level) => level.value === settingsStore.settings.thinkingLevel) ??
    thinkingLevels[2],
);

const permissionModes = [
  { value: 'plan' as const, label: '计划模式', icon: '◇', desc: '仅规划，不修改文件' },
  { value: 'full_access' as const, label: '完全访问', icon: '♢', desc: '无限制访问' },
  { value: 'auto_edit' as const, label: '自动编辑', icon: '✎', desc: '自动编辑文件' },
  { value: 'confirm_changes' as const, label: '变更前确认', icon: '✓', desc: '修改前需确认' },
];

const currentPerm = computed(
  () =>
    permissionModes.find(
      (permission) => permission.value === settingsStore.settings.permissionMode,
    ) ?? permissionModes[1],
);

function closeAll(): void {
  modelOpen.value = false;
  thinkingOpen.value = false;
  permOpen.value = false;
}

function onDocumentClick(event: MouseEvent): void {
  if (!inputRef.value?.contains(event.target as Node)) {
    closeAll();
  }
}

function toggleModel(): void {
  const nextState = !modelOpen.value;
  closeAll();
  modelOpen.value = nextState;
}

function toggleThinking(): void {
  const nextState = !thinkingOpen.value;
  closeAll();
  thinkingOpen.value = nextState;
}

function togglePerm(): void {
  const nextState = !permOpen.value;
  closeAll();
  permOpen.value = nextState;
}

function selectModel(option: { provider: string; model: string }): void {
  modelsStore.selectModel(option.provider, option.model);
  modelOpen.value = false;
}

function selectThinking(level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'): void {
  settingsStore.update({ thinkingLevel: level });
  thinkingOpen.value = false;
}

function selectPerm(mode: 'plan' | 'full_access' | 'auto_edit' | 'confirm_changes'): void {
  settingsStore.update({ permissionMode: mode });
  permOpen.value = false;
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
const inputHistory: string[] = [];
let historyIndex = -1;
// Saved draft so the user can return to what they typed after browsing history
let draftBeforeHistory = '';

function pushHistory(text: string): void {
  // Deduplicate consecutive identical entries
  if (inputHistory.length > 0 && inputHistory[inputHistory.length - 1] === text) return;
  inputHistory.push(text);
  if (inputHistory.length > HISTORY_MAX) inputHistory.shift();
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

onMounted(() => document.addEventListener('click', onDocumentClick));
onUnmounted(() => document.removeEventListener('click', onDocumentClick));
</script>

<template>
  <div ref="inputRef" class="chat-input">
    <div class="composer" :class="{ streaming: props.isStreaming }">
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="input-field"
        placeholder="提出后续修改要求"
        rows="1"
        @input="resizeTextarea"
        @keydown="handleKeydown"
      />

      <div class="composer-toolbar">
        <div class="toolbar-group toolbar-left">
          <button class="icon-btn add-btn" type="button" aria-label="添加上下文" disabled>
            <span aria-hidden="true">＋</span>
          </button>

          <div class="control-dropdown permission-dropdown" :class="{ open: permOpen }">
            <button
              class="toolbar-btn permission-btn"
              type="button"
              :aria-expanded="permOpen"
              aria-haspopup="menu"
              @click="togglePerm"
            >
              <span class="permission-icon" aria-hidden="true">{{ currentPerm.icon }}</span>
              <span class="btn-label">{{ currentPerm.label }}</span>
              <span class="chevron" aria-hidden="true">⌄</span>
            </button>
            <div v-if="permOpen" class="dropdown-menu permission-menu" role="menu">
              <button
                v-for="permission in permissionModes"
                :key="permission.value"
                class="dropdown-item"
                :class="{ active: permission.value === settingsStore.settings.permissionMode }"
                type="button"
                role="menuitem"
                @click="selectPerm(permission.value)"
              >
                <span class="item-icon">{{ permission.icon }}</span>
                <span class="item-info">
                  <span class="item-label">{{ permission.label }}</span>
                  <span class="item-desc">{{ permission.desc }}</span>
                </span>
              </button>
            </div>
          </div>
        </div>

        <div class="toolbar-group toolbar-right">
          <span
            class="status-indicator"
            :class="{ active: props.isStreaming }"
            aria-hidden="true"
          />

          <div class="control-dropdown model-dropdown" :class="{ open: modelOpen }">
            <button
              class="toolbar-btn model-btn"
              type="button"
              :aria-expanded="modelOpen"
              aria-haspopup="menu"
              @click="toggleModel"
            >
              <span class="btn-label">{{ currentModelLabel }}</span>
              <span class="chevron" aria-hidden="true">⌄</span>
            </button>
            <div v-if="modelOpen" class="dropdown-menu model-menu" role="menu">
              <button
                v-for="model in availableModels"
                :key="`${model.provider}/${model.model}`"
                class="dropdown-item"
                :class="{
                  active:
                    model.model === modelsStore.activeModel &&
                    model.provider === modelsStore.activeProvider,
                }"
                type="button"
                role="menuitem"
                @click="selectModel(model)"
              >
                <span class="item-label">{{ model.label }}</span>
                <span class="item-provider">{{ model.provider }}</span>
              </button>
            </div>
          </div>

          <div class="control-dropdown thinking-dropdown" :class="{ open: thinkingOpen }">
            <button
              class="toolbar-btn thinking-btn"
              type="button"
              :aria-expanded="thinkingOpen"
              aria-haspopup="menu"
              @click="toggleThinking"
            >
              <span class="thinking-icon" aria-hidden="true">♧</span>
              <span class="btn-label">{{ currentThinking.label }}</span>
              <span class="chevron" aria-hidden="true">⌄</span>
            </button>
            <div v-if="thinkingOpen" class="dropdown-menu thinking-menu" role="menu">
              <button
                v-for="level in thinkingLevels"
                :key="level.value"
                class="dropdown-item"
                :class="{ active: level.value === settingsStore.settings.thinkingLevel }"
                type="button"
                role="menuitem"
                @click="selectThinking(level.value)"
              >
                <span>{{ level.label }}</span>
                <span v-if="level.value === 'xhigh'" class="item-hint">最深度</span>
              </button>
            </div>
          </div>

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

.composer {
  position: relative;
  width: 100%;
  padding: 12px 14px 12px 16px;
  overflow: visible;
  border: 1px solid var(--border-color-strong);
  border-radius: 20px;
  background: var(--color-bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
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
  font-size: 15px;
  line-height: 1.55;
  box-shadow: none;
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

.icon-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  color: var(--color-text-secondary);
  font-size: 23px;
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
  font-size: 17px;
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
  border-radius: 10px;
  background: var(--color-accent);
  color: var(--color-bg);
  font-size: 20px;
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
  background: #e5534b;
  color: #fff;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.15s;
}
.stop-btn:hover {
  background: #c94038;
}

.dropdown-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  min-width: 190px;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border-color-strong);
  border-radius: 12px;
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
  font-size: 15px;
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
