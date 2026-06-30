<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useSessionsStore } from '../../stores/sessions';
import { useChatStore } from '../../stores/chat';
import { bridge } from '../../api/bridge';
import { useBackgroundProcesses } from '../../composables/useBackgroundProcesses';

const sessionsStore = useSessionsStore();
const chatStore = useChatStore();
const gitBranch = ref<string | null>(null);
const gitError = ref(false);

const { processes: bgProcesses } = useBackgroundProcesses();

const _runningBgCount = computed(
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
  void refreshGitInfo();
});

onMounted(() => {
  void refreshGitInfo();
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
    </div>

    <div class="header-actions">
      <span v-if="activeSession && _runningBgCount > 0" class="header-bg" title="后台运行中">
        ↻ {{ _runningBgCount }} 个后台
      </span>

      <span
        v-if="activeSession?.workingDirectory"
        class="header-git"
        :class="{ 'no-repo': !gitBranch && !gitError }"
      >
        <template v-if="gitError">⚠ git</template>
        <template v-else-if="gitBranch">⑂ {{ gitBranch }}</template>
        <template v-else>—</template>
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
  height: 60px;
  padding: 10px 154px 8px 20px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
  background: transparent;
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
  gap: 10px;
  height: 42px;
  max-width: 760px;
  padding: 0 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-surface) 94%, transparent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
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
  background: var(--color-bg-tertiary);
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
  gap: 8px;
  height: 42px;
}

.header-bg {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: var(--border-radius-sm);
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-surface));
  color: var(--color-accent);
  font-weight: 550;
  font-size: 11px;
}

.header-git {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: var(--border-radius-sm);
  background: color-mix(in srgb, var(--color-surface) 90%, transparent);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--color-text-muted);
}

.header-git.no-repo {
  opacity: 0.3;
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
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--border-radius-sm, 4px);
  background: color-mix(in srgb, var(--color-surface) 86%, transparent);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;
}

.more-btn:hover {
  background: var(--color-surface-hover, #eaeaea);
  color: var(--color-text);
}

.more-btn svg {
  width: 16px;
  height: 16px;
}
</style>
