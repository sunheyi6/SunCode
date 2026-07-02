<script setup lang="ts">
import { computed } from 'vue';
import {
  type DropdownState,
  getDropdownOpenState,
  useDropdown,
} from '../../composables/useDropdown';
import { useSettingsStore } from '../../stores/settings';

const props = withDefaults(
  defineProps<{
    dropdown?: DropdownState;
  }>(),
  {
    dropdown: undefined,
  },
);

const settingsStore = useSettingsStore();
const ownDropdown = useDropdown(false);
const dropdown = computed<DropdownState>(() => props.dropdown ?? ownDropdown);
const isOpen = computed(() => getDropdownOpenState(dropdown.value));

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

function selectThinking(level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'): void {
  settingsStore.update({ thinkingLevel: level });
  dropdown.value.close();
}

function toggle(): void {
  if (isOpen.value) {
    dropdown.value.close();
  } else {
    dropdown.value.open();
  }
}

defineExpose({
  toggle,
  close: dropdown.value.close,
  get isOpen() {
    return isOpen.value;
  },
});
</script>

<template>
  <div class="control-dropdown thinking-dropdown" :class="{ open: isOpen }">
    <button
      class="toolbar-btn thinking-btn"
      type="button"
      :aria-expanded="isOpen"
      aria-haspopup="menu"
      @click="toggle"
    >
      <span class="thinking-icon" aria-hidden="true">♧</span>
      <span class="btn-label">{{ currentThinking.label }}</span>
      <span class="chevron" aria-hidden="true">⌄</span>
    </button>
    <div v-if="isOpen" class="dropdown-menu thinking-menu" role="menu">
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
</template>

<style scoped>
.control-dropdown {
  position: relative;
  min-width: 0;
}

.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.08s ease, color 0.08s ease;
}

.toolbar-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.btn-label {
  white-space: nowrap;
  font-weight: 500;
}

.chevron {
  font-size: 11px;
  color: var(--color-text-muted);
}

.thinking-btn {
  min-width: 70px;
}

.thinking-icon {
  font-size: 12px;
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

.thinking-menu {
  min-width: 120px;
}

.thinking-menu .item-hint {
  font-size: 10px;
  color: var(--color-accent);
  margin-left: auto;
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
  transition: background 0.08s ease, color 0.08s ease;
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

.item-info {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.item-label {
  white-space: nowrap;
}
</style>
