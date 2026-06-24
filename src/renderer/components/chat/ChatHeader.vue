<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useSessionsStore } from '../../stores/sessions';
import { bridge } from '../../api/bridge';
import { useBackgroundProcesses } from '../../composables/useBackgroundProcesses';

const sessionsStore = useSessionsStore();
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
watch(folderName, (name) => {
  if (name) {
    bridge.setTitleBarOverlayText(name);
  }
}, { immediate: true });

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
  height: 38px;
  padding: 0 16px;
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

/* Right actions */
.header-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-bg {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: var(--border-radius-sm);
  background: color-mix(in srgb, var(--color-accent) 15%, transparent);
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
  background: var(--color-surface);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--color-text-muted);
}

.header-git.no-repo {
  opacity: 0.3;
}

.more-btn {
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
