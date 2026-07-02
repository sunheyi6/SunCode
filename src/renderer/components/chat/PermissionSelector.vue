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

function selectPerm(mode: 'plan' | 'full_access' | 'auto_edit' | 'confirm_changes'): void {
  settingsStore.update({ permissionMode: mode });
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
  <div class="control-dropdown permission-dropdown" :class="{ open: isOpen }">
    <button
      class="toolbar-btn permission-btn"
      type="button"
      :aria-expanded="isOpen"
      aria-haspopup="menu"
      @click="toggle"
    >
      <span class="permission-icon" aria-hidden="true">{{ currentPerm.icon }}</span>
      <span class="btn-label">{{ currentPerm.label }}</span>
      <span class="chevron" aria-hidden="true">⌄</span>
    </button>
    <div v-if="isOpen" class="dropdown-menu permission-menu" role="menu">
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

.permission-btn {
  min-width: 90px;
}

.permission-icon {
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

.permission-menu {
  min-width: 180px;
}

.permission-menu .item-icon {
  width: 16px;
  flex-shrink: 0;
  text-align: center;
}

.permission-menu .item-desc {
  font-size: 10px;
  color: var(--color-text-muted);
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
