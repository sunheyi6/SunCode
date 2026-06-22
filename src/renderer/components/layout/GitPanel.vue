<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { GitInfo } from '@shared/types';
import { useSessionsStore } from '../../stores/sessions';
import { bridge } from '../../api/bridge';
import { useBackgroundProcesses } from '../../composables/useBackgroundProcesses';
import {
  formatElapsedTime,
  latestProcess,
} from '../../composables/background-process-state';

const sessionsStore = useSessionsStore();

const gitStatus = ref<GitInfo>({
  isRepo: false,
  addedLines: 0,
  deletedLines: 0,
  changedFiles: 0,
  stagedFiles: 0,
});
const collapsed = ref(true);
const now = ref(Date.now());
const panelRef = ref<HTMLElement | null>(null);
const { processes } = useBackgroundProcesses();

const activeSession = computed(() =>
  sessionsStore.sessions.find((s) => s.id === sessionsStore.activeSessionId),
);

const latest = computed(() => latestProcess([...processes.value]));
const runningCount = computed(
  () => processes.value.filter((process) => process.status === 'running').length,
);
const hasChanges = computed(
  () => gitStatus.value.changedFiles > 0 || gitStatus.value.stagedFiles > 0,
);
const elapsedText = computed(() => {
  const process = latest.value;
  if (!process) return '未运行';
  const end = process.endTime ?? now.value;
  return formatElapsedTime(end - process.startTime);
});

async function refreshGit(): Promise<void> {
  const dir = activeSession.value?.workingDirectory;
  if (!dir) {
    gitStatus.value = {
      isRepo: false,
      addedLines: 0,
      deletedLines: 0,
      changedFiles: 0,
      stagedFiles: 0,
    };
    return;
  }
  try {
    gitStatus.value = await bridge.getGitInfo(dir);
  } catch {
    gitStatus.value = {
      isRepo: false,
      addedLines: 0,
      deletedLines: 0,
      changedFiles: 0,
      stagedFiles: 0,
    };
  }
}

watch(
  () => activeSession.value?.workingDirectory,
  () => {
    collapsed.value = true;
    void refreshGit();
  },
);

function togglePanel(): void {
  collapsed.value = !collapsed.value;
}

function onDocumentClick(e: MouseEvent): void {
  if (!collapsed.value && !panelRef.value?.contains(e.target as Node)) {
    collapsed.value = true;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  void refreshGit();
  document.addEventListener('click', onDocumentClick);
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick);
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div v-if="gitStatus.isRepo" ref="panelRef" class="git-float">
    <button
      class="git-pill"
      type="button"
      :aria-expanded="!collapsed"
      :aria-label="collapsed ? '展开 Git 和进程信息' : '收起 Git 和进程信息'"
      @click="togglePanel"
    >
      <span class="branch-icon" aria-hidden="true">⑂</span>
      <span class="pill-branch">{{ gitStatus.branch || 'HEAD' }}</span>
      <span v-if="hasChanges" class="pill-dot" aria-label="存在未提交更改" />
      <span v-if="hasChanges" class="pill-count">
        +{{ gitStatus.addedLines }} −{{ gitStatus.deletedLines }}
      </span>
      <span aria-hidden="true">{{ collapsed ? '⌄' : '⌃' }}</span>
    </button>

    <section v-if="!collapsed" class="git-card" aria-label="Git 和后台进程信息">
      <header class="card-header">
        <span>Git 工具</span>
        <button type="button" class="icon-button" aria-label="刷新 Git 信息" @click="refreshGit">
          ↻
        </button>
      </header>

      <div class="info-row">
        <span>▣　更改</span>
        <span class="line-stats">
          <strong class="added">+{{ gitStatus.addedLines }}</strong>
          <strong class="deleted">-{{ gitStatus.deletedLines }}</strong>
        </span>
      </div>
      <div class="info-row"><span>⑂　{{ gitStatus.branch || 'HEAD' }}</span></div>
      <button type="button" class="commit-row" title="提交功能将在后续流程中接入">
        <span>─　提交</span><span>•••</span>
      </button>

      <div class="section-divider" />
      <section class="process-section">
        <div class="section-heading">
          <span>进程</span><span>{{ latest ? '1/1' : '0/0' }}</span>
        </div>
        <div v-if="latest" class="process-command" :title="latest.command">
          <span :class="['status-mark', latest.status]">
            {{ latest.status === 'running' ? '●' : latest.status === 'completed' ? '✓' : '×' }}
          </span>
          <span class="command-text">{{ latest.command }}</span>
        </div>
        <div v-else class="empty-process">暂无运行进程</div>
      </section>

      <div class="section-divider" />
      <footer class="runtime-row">
        <span>{{ latest?.status === 'running' ? '运行中' : '运行状态' }}</span>
        <span>
          {{ elapsedText }} · {{ runningCount }} 后台
          <template v-if="latest?.status === 'error' && latest.exitCode !== undefined">
            · 退出码 {{ latest.exitCode }}
          </template>
        </span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.git-float {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: calc(100% - 20px);
}

.git-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  max-width: min(320px, calc(100vw - 40px));
  padding: 3px 10px;
  border: 1px solid var(--border-color-strong);
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-bg-secondary) 92%, transparent);
  color: var(--color-text-secondary);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(10px);
}

.git-card {
  width: min(390px, calc(100vw - 40px));
  margin-top: 6px;
  overflow: hidden;
  border: 1px solid var(--border-color-strong);
  border-radius: 14px;
  background: var(--color-bg-secondary);
  color: var(--color-text);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
}

.card-header,
.info-row,
.commit-row,
.runtime-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 40px;
  padding: 0 14px;
}

.section-divider {
  height: 1px;
  margin: 4px 10px;
  background: var(--border-color-strong);
}

.added { color: var(--color-green); }
.deleted { color: var(--color-red); }
.process-command,
.empty-process,
.process-section { min-width: 0; }
.command-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-pill:hover,
.icon-button:hover,
.commit-row:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.pill-branch,
.command-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pill-branch {
  max-width: 120px;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-weight: 600;
}

.pill-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--color-yellow);
}

.pill-count,
.line-stats {
  display: flex;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
}

.card-header,
.section-heading,
.runtime-row {
  color: var(--color-text-muted);
}

.card-header {
  font-size: 12px;
}

.icon-button {
  width: 26px;
  height: 26px;
  padding: 0;
  background: transparent;
  color: var(--color-text-secondary);
}

.commit-row {
  width: 100%;
  border-radius: 0;
  background: transparent;
  color: var(--color-text);
  text-align: left;
}

.process-section {
  padding: 10px 14px 12px;
}

.section-heading {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 12px;
}

.process-command {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-secondary);
}

.status-mark.running { color: var(--color-accent); }
.status-mark.completed { color: var(--color-green); }
.status-mark.error { color: var(--color-red); }

.empty-process {
  color: var(--color-text-muted);
  font-size: 12px;
}

.runtime-row {
  gap: 16px;
  min-height: 50px;
  font-size: 12px;
}

.runtime-row span:last-child {
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
