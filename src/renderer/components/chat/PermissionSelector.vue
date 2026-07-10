<script setup lang="ts">
import { computed } from 'vue';
import {
  type DropdownState,
  getDropdownOpenState,
  useDropdown,
} from '../../composables/useDropdown';
import { useSettingsStore } from '../../stores/settings';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';

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
  { value: 'plan' as const, label: '计划模式', icon: 'list-checks', desc: '仅规划，不修改文件' },
  { value: 'full_access' as const, label: '完全访问', icon: 'unlock', desc: '无限制访问' },
  { value: 'auto_edit' as const, label: '自动编辑', icon: 'pencil', desc: '自动编辑文件' },
  {
    value: 'confirm_changes' as const,
    label: '变更前确认',
    icon: 'shield-check',
    desc: '修改前需确认',
  },
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
      <span class="permission-icon" aria-hidden="true">
        <AppIcon :name="currentPerm.icon" :size="14" />
      </span>
      <span class="btn-label">{{ currentPerm.label }}</span>
      <span class="chevron" aria-hidden="true"><AppIcon name="chevron-down" :size="14" /></span>
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
        <span class="item-icon"><AppIcon :name="permission.icon" :size="14" /></span>
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
  height: 34px;
  padding: 0 9px;
  border: 0;
  border-radius: var(--border-radius-pill);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 1;
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
  font-size: 12px;
  color: var(--color-text-muted);
}

.permission-btn {
  min-width: 90px;
}

.permission-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
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
  background: color-mix(in srgb, var(--color-bg) 88%, transparent);
  backdrop-filter: blur(24px) saturate(160%);
  box-shadow: var(--shadow-lg);
  padding: 5px;
  z-index: 100;
}

.permission-menu {
  min-width: 180px;
}

.permission-menu .item-icon {
  display: inline-flex;
  width: 16px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
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
  border-radius: var(--border-radius-sm);
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
