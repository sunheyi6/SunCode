<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useModelsStore } from '../../stores/models';
import { useSettingsStore } from '../../stores/settings';

const modelsStore = useModelsStore();
const settingsStore = useSettingsStore();

// ── dropdown state ──
const modelOpen = ref(false);
const thinkingOpen = ref(false);
const permOpen = ref(false);
const toolbarRef = ref<HTMLElement | null>(null);

function closeAll(): void {
  modelOpen.value = false;
  thinkingOpen.value = false;
  permOpen.value = false;
}

function onDocumentClick(e: MouseEvent): void {
  if (!toolbarRef.value?.contains(e.target as Node)) {
    closeAll();
  }
}

onMounted(() => document.addEventListener('click', onDocumentClick));
onUnmounted(() => document.removeEventListener('click', onDocumentClick));

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function toggleModel(): void {
  closeAll();
  modelOpen.value = !modelOpen.value;
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function toggleThinking(): void {
  closeAll();
  thinkingOpen.value = !thinkingOpen.value;
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function togglePerm(): void {
  closeAll();
  permOpen.value = !permOpen.value;
}

// ── model list ──
const availableModels = computed(() => modelsStore.recommendedModels);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const currentModelLabel = computed(() => {
  const m = availableModels.value.find(
    (m) => m.model === modelsStore.activeModel && m.provider === modelsStore.activeProvider,
  );
  return m?.label ?? `${modelsStore.activeProvider}/${modelsStore.activeModel}`;
});

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function selectModel(option: { provider: string; model: string }): void {
  modelsStore.selectModel(option.provider, option.model);
  modelOpen.value = false;
}

// ── thinking level ──
const thinkingLevels = [
  { value: 'minimal' as const, label: '最小' },
  { value: 'low' as const, label: '低' },
  { value: 'medium' as const, label: '中' },
  { value: 'high' as const, label: '高' },
  { value: 'xhigh' as const, label: '最大' },
];

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const currentThinking = computed(
  () =>
    thinkingLevels.find((l) => l.value === settingsStore.settings.thinkingLevel) ??
    thinkingLevels[2],
);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function selectThinking(level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'): void {
  settingsStore.update({ thinkingLevel: level });
  thinkingOpen.value = false;
}

// ── permission mode ──
const permissionModes = [
  { value: 'plan' as const, label: '计划模式', icon: '📋', desc: '仅规划，不修改文件' },
  { value: 'full_access' as const, label: '完全访问', icon: '🔓', desc: '无限制访问' },
  { value: 'auto_edit' as const, label: '自动编辑', icon: '✏️', desc: '自动编辑文件' },
  { value: 'confirm_changes' as const, label: '变更前确认', icon: '✅', desc: '修改前需确认' },
];

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const currentPerm = computed(
  () =>
    permissionModes.find((p) => p.value === settingsStore.settings.permissionMode) ??
    permissionModes[1],
);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function selectPerm(mode: 'plan' | 'full_access' | 'auto_edit' | 'confirm_changes'): void {
  settingsStore.update({ permissionMode: mode });
  permOpen.value = false;
}
</script>

<template>
  <div ref="toolbarRef" class="chat-toolbar">
    <!-- Model selector -->
    <div class="toolbar-dropdown" :class="{ open: modelOpen }">
      <button class="toolbar-btn model-btn" @click="toggleModel">
        <span class="btn-label">{{ currentModelLabel }}</span>
        <span class="btn-caret">▾</span>
      </button>
      <div v-if="modelOpen" class="dropdown-menu model-menu">
        <button
          v-for="m in availableModels"
          :key="`${m.provider}/${m.model}`"
          class="dropdown-item"
          :class="{ active: m.model === modelsStore.activeModel && m.provider === modelsStore.activeProvider }"
          @click="selectModel(m)"
        >
          <span class="item-label">{{ m.label }}</span>
          <span class="item-provider">{{ m.provider }}</span>
        </button>
      </div>
    </div>

    <!-- Thinking level -->
    <div class="toolbar-dropdown" :class="{ open: thinkingOpen }">
      <button class="toolbar-btn" @click="toggleThinking">
        <span class="btn-label">思考: {{ currentThinking.label }}</span>
        <span class="btn-caret">▾</span>
      </button>
      <div v-if="thinkingOpen" class="dropdown-menu">
        <button
          v-for="l in thinkingLevels"
          :key="l.value"
          class="dropdown-item"
          :class="{ active: l.value === settingsStore.settings.thinkingLevel }"
          @click="selectThinking(l.value)"
        >
          {{ l.label }}
          <span class="item-hint">{{ l.value === 'minimal' ? '最快' : l.value === 'xhigh' ? '最深度' : '' }}</span>
        </button>
      </div>
    </div>

    <!-- Permission mode -->
    <div class="toolbar-dropdown" :class="{ open: permOpen }">
      <button class="toolbar-btn perm-btn" @click="togglePerm">
        <span class="btn-label">{{ currentPerm.icon }} {{ currentPerm.label }}</span>
        <span class="btn-caret">▾</span>
      </button>
      <div v-if="permOpen" class="dropdown-menu">
        <button
          v-for="p in permissionModes"
          :key="p.value"
          class="dropdown-item"
          :class="{ active: p.value === settingsStore.settings.permissionMode }"
          @click="selectPerm(p.value)"
        >
          <span class="item-icon">{{ p.icon }}</span>
          <div class="item-info">
            <span class="item-label">{{ p.label }}</span>
            <span class="item-desc">{{ p.desc }}</span>
          </div>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-color);
  background: var(--color-bg-tertiary);
  flex-shrink: 0;
}

/* ── Dropdown container ── */
.toolbar-dropdown {
  position: relative;
}

/* ── Trigger button ── */
.toolbar-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--border-radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.12s;
}

.toolbar-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.toolbar-dropdown.open .toolbar-btn {
  background: var(--color-surface);
  border-color: var(--border-color-strong);
  color: var(--color-text);
}

.btn-label {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-btn .btn-label {
  max-width: 120px;
  font-weight: 550;
  color: var(--color-accent);
}

.perm-btn .btn-label {
  max-width: 100px;
}

.btn-caret {
  font-size: 10px;
  opacity: 0.5;
}

/* ── Dropdown menu ── */
.dropdown-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 3px;
  min-width: 180px;
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--border-color-strong);
  border-radius: var(--border-radius);
  background: var(--color-bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  z-index: 100;
}

.model-menu {
  min-width: 240px;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.08s;
}

.dropdown-item:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.dropdown-item.active {
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  color: var(--color-accent);
  font-weight: 550;
}

.item-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.item-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.item-label {
  white-space: nowrap;
}

.item-desc {
  font-size: 10px;
  color: var(--color-text-muted);
}

.item-provider {
  margin-left: auto;
  font-size: 10px;
  color: var(--color-text-muted);
  text-transform: uppercase;
}

.item-hint {
  margin-left: auto;
  font-size: 10px;
  color: var(--color-text-muted);
}
</style>
