<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useSessionsStore } from '../../stores/sessions';
import { bridge } from '../../api/bridge';
import { useBackgroundProcesses } from '../../composables/useBackgroundProcesses';

const sessionsStore = useSessionsStore();
const gitBranch = ref<string | null>(null);
const gitError = ref(false);

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
  <div v-if="activeSession" class="chat-header">
    <div class="header-main">
      <span class="header-title">{{ activeSession.name }}</span>
    </div>
    <div class="header-meta">
      <!-- Background processes -->
      <span v-if="runningBgCount > 0" class="header-bg" title="后台运行中">
        ↻ {{ runningBgCount }} 个后台
      </span>

      <span class="header-folder" :title="activeSession.workingDirectory">
        ▣ {{ folderName }}
      </span>
      <span
        v-if="activeSession.workingDirectory"
        class="header-git"
        :class="{ 'no-repo': !gitBranch && !gitError }"
      >
        <template v-if="gitError">⚠ git</template>
        <template v-else-if="gitBranch">⑂ {{ gitBranch }}</template>
        <template v-else>—</template>
      </span>
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
}

.header-main {
  min-width: 0;
  flex: 1;
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

.header-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-text-muted);
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
}

.header-folder {
  display: flex;
  align-items: center;
  gap: 4px;
}

.header-git {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
  font-family: var(--font-mono, monospace);
}

.header-git.no-repo {
  opacity: 0.3;
}
</style>
