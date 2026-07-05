<script setup lang="ts">
import type { GitBranch } from '@shared/types';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { bridge } from '../../api/bridge';
import { useBackgroundProcesses } from '../../composables/useBackgroundProcesses';
import { useSessionsStore } from '../../stores/sessions';

const sessionsStore = useSessionsStore();
const gitBranch = ref<string | null>(null);
const gitError = ref(false);
const branchMenuOpen = ref(false);
const branchList = ref<GitBranch[]>([]);
const branchLoading = ref(false);
const branchSwitching = ref(false);
const branchMenuError = ref('');
const branchDropdown = ref<HTMLElement | null>(null);

const { processes: bgProcesses } = useBackgroundProcesses();

const runningBgCount = computed(
  () => bgProcesses.value.filter((p) => p.status === 'running').length,
);

const activeSession = computed(() =>
  sessionsStore.sessions.find((s) => s.id === sessionsStore.activeSessionId),
);

const folderName = computed(() => {
  const dir = activeSession.value?.workingDirectory;
  if (!dir) return '';
  const segments = dir.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || dir;
});

// Sync folder name to native title bar overlay
watch(
  folderName,
  (name) => {
    if (name) {
      bridge.setTitleBarOverlayText(name);
    }
  },
  { immediate: true },
);

async function refreshGitInfo(): Promise<void> {
  const dir = activeSession.value?.workingDirectory;
  if (!dir) {
    gitBranch.value = null;
    return;
  }
  try {
    const info = await bridge.getGitInfo(dir);
    gitError.value = false;
    gitBranch.value = info.isRepo ? info.branch || 'HEAD' : null;
  } catch {
    gitError.value = true;
    gitBranch.value = null;
  }
}

watch(activeSession, () => {
  closeBranchMenu();
  void refreshGitInfo();
});

async function loadBranches(): Promise<void> {
  const dir = activeSession.value?.workingDirectory;
  if (!dir) return;

  branchLoading.value = true;
  branchMenuError.value = '';
  try {
    branchList.value = await bridge.listGitBranches(dir);
    if (branchList.value.length === 0) {
      branchMenuError.value = '没有可切换的本地分支';
    }
  } catch {
    branchList.value = [];
    branchMenuError.value = '读取分支失败';
  } finally {
    branchLoading.value = false;
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
async function toggleBranchMenu(): Promise<void> {
  if (!activeSession.value?.workingDirectory || gitError.value || !gitBranch.value) return;

  if (branchMenuOpen.value) {
    closeBranchMenu();
    return;
  }

  branchMenuOpen.value = true;
  await loadBranches();
}

function closeBranchMenu(): void {
  branchMenuOpen.value = false;
  branchMenuError.value = '';
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
async function checkoutBranch(branch: GitBranch): Promise<void> {
  const dir = activeSession.value?.workingDirectory;
  if (!dir || branch.current || branchSwitching.value) return;

  branchSwitching.value = true;
  branchMenuError.value = '';
  try {
    const result = await bridge.checkoutGitBranch(dir, branch.name);
    if (!result.success) {
      branchMenuError.value = result.error || '切换分支失败';
      return;
    }
    gitBranch.value = result.branch || branch.name;
    await refreshGitInfo();
    await loadBranches();
    closeBranchMenu();
  } catch {
    branchMenuError.value = '切换分支失败';
  } finally {
    branchSwitching.value = false;
  }
}

function handleDocumentClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (!branchDropdown.value?.contains(target)) {
    closeBranchMenu();
  }
}

onMounted(() => {
  void refreshGitInfo();
  document.addEventListener('click', handleDocumentClick);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick);
});
</script>

<template>
  <div class="chat-header">
    <div class="header-main">
      <span v-if="activeSession" class="header-title">{{ activeSession.name }}</span>
      <span v-else class="header-title">SunCode</span>
      <span v-if="folderName" class="header-folder" :title="activeSession?.workingDirectory">
        {{ folderName }}
      </span>

      <div
        v-if="activeSession?.workingDirectory"
        ref="branchDropdown"
        class="header-git-dropdown"
        :class="{ 'no-repo': !gitBranch && !gitError }"
      >
        <button
          class="header-git"
          type="button"
          :disabled="gitError || !gitBranch"
          :aria-expanded="branchMenuOpen"
          aria-haspopup="menu"
          title="切换 Git 分支"
          @click.stop="toggleBranchMenu"
        >
        <template v-if="gitError">⚠ git</template>
        <template v-else-if="gitBranch">⑂ {{ gitBranch }}</template>
        <template v-else>—</template>
          <span v-if="gitBranch && !gitError" class="git-chevron">⌄</span>
        </button>

        <div v-if="branchMenuOpen" class="branch-menu" role="menu">
          <div v-if="branchLoading" class="branch-menu-note">读取分支中...</div>
          <template v-else>
            <button
              v-for="branch in branchList"
              :key="branch.name"
              class="branch-menu-item"
              :class="{ active: branch.current }"
              type="button"
              role="menuitem"
              :disabled="branch.current || branchSwitching"
              @click.stop="checkoutBranch(branch)"
            >
              <span class="branch-check">{{ branch.current ? '✓' : '' }}</span>
              <span class="branch-label">{{ branch.name }}</span>
            </button>
          </template>
          <div v-if="branchMenuError" class="branch-menu-error">{{ branchMenuError }}</div>
        </div>
      </div>
    </div>

    <div class="header-actions">
      <span v-if="activeSession && runningBgCount > 0" class="header-bg" title="后台运行中">
        ↻ {{ runningBgCount }} 个后台
      </span>

      <button class="more-btn" title="更多">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 44px;
  padding: 5px 14px 5px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
  /* The entire header is a drag region for the frameless window.
     Only interactive elements (buttons, links) are excluded. */
  -webkit-app-region: drag;
  app-region: drag;
}

.chat-header button,
.chat-header a,
.chat-header input,
.chat-header textarea,
.chat-header select,
.chat-header [role="button"] {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.header-main {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  max-width: 760px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.header-title {
  display: block;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-folder {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 190px;
  overflow: hidden;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--color-surface-hover);
  color: var(--color-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Right actions */
.header-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
}

.header-bg {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: var(--border-radius-sm);
  background: var(--color-surface-hover);
  color: var(--color-text);
  font-weight: 550;
  font-size: 11px;
}

.header-git-dropdown {
  position: relative;
  flex-shrink: 0;
}

.header-git {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border: none;
  border-radius: var(--border-radius-sm);
  background: transparent;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.header-git:hover:not(:disabled) {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.header-git:disabled {
  cursor: default;
}

.header-git-dropdown.no-repo {
  opacity: 0.3;
}

.git-chevron {
  margin-left: 2px;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  opacity: 0.7;
}

.branch-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 50;
  min-width: 220px;
  max-width: 360px;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--border-color-strong);
  border-radius: 8px;
  background: var(--color-bg);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.18);
}

.branch-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 28px;
  padding: 5px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  text-align: left;
}

.branch-menu-item:hover:not(:disabled) {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.branch-menu-item.active {
  color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
}

.branch-menu-item:disabled {
  cursor: default;
}

.branch-check {
  width: 12px;
  flex: 0 0 12px;
  color: var(--color-accent);
}

.branch-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-menu-note,
.branch-menu-error {
  padding: 8px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.branch-menu-error {
  color: var(--color-red);
}

.trace-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--border-radius-sm, 4px);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 14px;
  transition: background 0.2s ease, color 0.2s ease;
}

.trace-btn:hover {
  background: var(--color-surface-hover, #eaeaea);
  color: var(--color-text);
}

.trace-btn.active {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent);
}

.more-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--border-radius-sm, 4px);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;
}

.more-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.more-btn svg {
  width: 14px;
  height: 14px;
}
</style>
