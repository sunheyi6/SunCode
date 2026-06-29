<script setup lang="ts">
import { computed } from 'vue';
import { useSessionsStore } from '../../stores/sessions';
import { getDropdownOpenState, useDropdown, type DropdownState } from '../../composables/useDropdown';
import { bridge } from '../../api/bridge';
import type { GitInfo } from '@shared/types';

const props = withDefaults(
  defineProps<{
    gitInfo: GitInfo;
    dropdown?: DropdownState;
  }>(),
  {
    dropdown: undefined,
  },
);

const sessionsStore = useSessionsStore();
const ownDropdown = useDropdown(false);
const dropdown = computed<DropdownState>(() => props.dropdown ?? ownDropdown);
const isOpen = computed(() => getDropdownOpenState(dropdown.value));

const activeSession = computed(() =>
  sessionsStore.sessions.find((s) => s.id === sessionsStore.activeSessionId),
);

const workspaceName = computed(() => {
  const dir = activeSession.value?.workingDirectory;
  if (!dir) return '未选择文件夹';
  const segments = dir.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || dir;
});

const workspacePath = computed(() => activeSession.value?.workingDirectory || '');

const gitBranch = computed(() => (props.gitInfo.isRepo ? props.gitInfo.branch : null));

const recentFolders = computed(() => {
  const seen = new Map<string, { path: string; sessionId: string; updated: number }>();
  for (const s of sessionsStore.sessions) {
    const dir = s.workingDirectory;
    if (!dir) continue;
    const ts = new Date(s.updated).getTime();
    const entry = seen.get(dir);
    if (!entry || ts > entry.updated) {
      seen.set(dir, { path: dir, sessionId: s.id, updated: ts });
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 20);
});

async function selectFolder() {
  dropdown.value.close();
  const dir = await bridge.selectDirectory();
  if (dir) {
    await sessionsStore.createSession(dir);
  }
}

function switchToFolder(item: { path: string; sessionId: string }) {
  dropdown.value.close();
  const session = sessionsStore.sessions.find(
    (s) => s.workingDirectory === item.path,
  );
  if (session && session.id !== sessionsStore.activeSessionId) {
    sessionsStore.selectSession(session.id);
  }
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
  <div class="workspace-bar">
    <div class="control-dropdown folder-dropdown" :class="{ open: isOpen }">
      <button
        class="workspace-folder"
        type="button"
        :aria-expanded="isOpen"
        aria-haspopup="menu"
        @click="toggle"
      >
        <span class="folder-icon" aria-hidden="true">📁</span>
        <span class="workspace-name">{{ workspaceName }}</span>
        <span class="chevron" aria-hidden="true">⌄</span>
      </button>
      <div v-if="isOpen" class="dropdown-menu folder-menu" role="menu">
        <button
          v-for="item in recentFolders"
          :key="item.path"
          class="dropdown-item"
          :class="{ active: item.path === workspacePath }"
          type="button"
          role="menuitem"
          @click="switchToFolder(item)"
        >
          <span class="item-folder-icon">📁</span>
          <span class="item-info">
            <span class="item-label">{{ item.path.split(/[\\/]/).filter(Boolean).pop() || item.path }}</span>
            <span class="item-desc">{{ item.path }}</span>
          </span>
        </button>
        <div v-if="recentFolders.length > 0" class="dropdown-divider" />
        <button
          class="dropdown-item pick-folder-item"
          type="button"
          role="menuitem"
          @click="selectFolder"
        >
          <span class="item-icon-pick">＋</span>
          <span class="item-info">
            <span class="item-label">选择其他文件夹...</span>
          </span>
        </button>
      </div>
    </div>
    <div v-if="gitBranch" class="git-branch">
      <span class="branch-icon" aria-hidden="true">⑂</span>
      <span class="branch-name">{{ gitBranch }}</span>
    </div>
  </div>
</template>

<style scoped>
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

.control-dropdown {
  position: relative;
  min-width: 0;
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
