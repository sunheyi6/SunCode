<script setup lang="ts">
import type { GitInfo, TaskPlan, TaskStep } from '@shared/types';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { bridge } from '../../api/bridge';
import { formatElapsedTime, markProcessKilled } from '../../composables/background-process-state';
import { useBackgroundProcesses } from '../../composables/useBackgroundProcesses';
import { useToast } from '../../composables/useToast';
import { useChatStore } from '../../stores/chat';
import { useSessionsStore } from '../../stores/sessions';

const sessionsStore = useSessionsStore();
const chatStore = useChatStore();

const gitStatus = ref<GitInfo>({
  isRepo: false,
  addedLines: 0,
  deletedLines: 0,
  changedFiles: 0,
  stagedFiles: 0,
});
const collapsed = ref(true);
const showCommitForm = ref(false);
const commitMessage = ref('');
const generatingCommitMsg = ref(false);
const committing = ref(false);
const commitFeedback = ref('');
const now = ref(Date.now());
const panelRef = ref<HTMLElement | null>(null);
const showAllPlan = ref(false);
const planStartTime = ref(0);
const { processes } = useBackgroundProcesses();
const { showToast } = useToast();

const activeSession = computed(() =>
  sessionsStore.sessions.find((s) => s.id === sessionsStore.activeSessionId),
);

const sortedProcesses = computed(() =>
  [...processes.value]
    .filter((p) => !p.killed)
    .sort((a, b) => {
      // Running processes first, then by recency
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (a.status !== 'running' && b.status === 'running') return 1;
      return b.startTime - a.startTime;
    }),
);
const runningCount = computed(
  () => processes.value.filter((process) => process.status === 'running' && !process.killed).length,
);

function formatProcessTime(proc: { status: string; startTime: number; endTime?: number }): string {
  if (proc.status === 'running') {
    return formatElapsedTime(now.value - proc.startTime);
  }
  if (proc.status === 'completed') return '已完成';
  return '已停止';
}

function stopProcess(pid: number): void {
  const proc = processes.value.find((p) => p.pid === pid);
  if (!proc) return;
  markProcessKilled(processes.value, pid);
  bridge.killBgProcess(pid);
  showToast(`已停止进程: ${proc.command.slice(0, 40)}`, 'warning');
}
const hasChanges = computed(
  () => gitStatus.value.changedFiles > 0 || gitStatus.value.stagedFiles > 0,
);

// ── Task Plan ──

const latestPlan = computed<TaskPlan | null>(() => {
  const msgs = chatStore.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'assistant' && msgs[i]?.taskPlan) {
      return msgs[i].taskPlan ?? null;
    }
  }
  return null;
});

const hasPlan = computed(() => latestPlan.value !== null);
const planSteps = computed<TaskStep[]>(() => latestPlan.value?.steps ?? []);
const planDone = computed(() => planSteps.value.filter((s) => s.status === 'done').length);
const planTotal = computed(() => planSteps.value.length);
const planAllDone = computed(() => planDone.value === planTotal.value && planTotal.value > 0);

const visiblePlanSteps = computed(() => {
  if (showAllPlan.value || planSteps.value.length <= 5) return planSteps.value;
  return planSteps.value.slice(0, 5);
});

const hiddenPlanCount = computed(() => Math.max(0, planSteps.value.length - 5));

function planStepIcon(status: string): string {
  if (status === 'done') return '✓';
  if (status === 'in_progress') return '◉';
  return '○';
}

const showPanel = computed(
  () => chatStore.messages.length > 0 && (gitStatus.value.isRepo || hasPlan.value),
);

// Track plan elapsed time
const planElapsed = computed(() => {
  if (!planStartTime.value) return '';
  const sec = Math.round((now.value - planStartTime.value) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s}s`;
});

// Track plan start time + auto-expand when plan appears
watch(hasPlan, (val) => {
  if (val && !planStartTime.value) {
    planStartTime.value = Date.now();
    collapsed.value = false; // Auto-expand to show the plan
  } else if (!val) {
    planStartTime.value = 0;
  }
});
const elapsedText = computed(() => {
  const running = sortedProcesses.value.find((p) => p.status === 'running');
  if (!running) return '未运行';
  return formatElapsedTime(now.value - running.startTime);
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
  if (collapsed.value) {
    showCommitForm.value = false;
  } else {
    void refreshGit();
  }
}

function toggleCommitForm(): void {
  showCommitForm.value = !showCommitForm.value;
  commitFeedback.value = '';
  if (!showCommitForm.value) {
    commitMessage.value = '';
  }
}

async function generateCommitMessage(): Promise<void> {
  const dir = activeSession.value?.workingDirectory;
  if (!dir) return;
  generatingCommitMsg.value = true;
  try {
    const result = await bridge.generateCommitMessage(dir);
    commitMessage.value = result.message;
  } catch {
    commitFeedback.value = '❌ AI 生成失败';
  } finally {
    generatingCommitMsg.value = false;
  }
}

async function doCommit(): Promise<void> {
  const dir = activeSession.value?.workingDirectory;
  if (!dir) return;
  let msg = commitMessage.value.trim();

  // Auto-generate if empty
  if (!msg) {
    generatingCommitMsg.value = true;
    commitFeedback.value = '🤖 AI 正在生成提交信息...';
    try {
      const result = await bridge.generateCommitMessage(dir);
      msg = result.message;
      commitMessage.value = msg;
    } catch {
      commitFeedback.value = '❌ AI 生成失败';
      return;
    } finally {
      generatingCommitMsg.value = false;
    }
  }

  committing.value = true;
  commitFeedback.value = '⏳ 正在提交...';
  try {
    const result = await bridge.gitCommit(dir, msg);
    if (result.success) {
      commitFeedback.value = '✓ 提交成功';
      commitMessage.value = '';
      showCommitForm.value = false;
      void refreshGit();
    } else {
      commitFeedback.value = `❌ ${result.error || '提交失败'}`;
    }
  } catch {
    commitFeedback.value = '❌ 提交失败';
  } finally {
    committing.value = false;
  }
}

function onDocumentClick(e: MouseEvent): void {
  if (!collapsed.value && !panelRef.value?.contains(e.target as Node)) {
    collapsed.value = true;
  }
}

let clockTimer: ReturnType<typeof setInterval> | undefined;
let gitTimer: ReturnType<typeof setInterval> | undefined;
let cleanupToolEnd: (() => void) | undefined;
let throttledRefreshTimer: ReturnType<typeof setTimeout> | undefined;

/** Throttled refresh — call after tool execution or file writes. */
function scheduleRefresh(): void {
  if (throttledRefreshTimer) clearTimeout(throttledRefreshTimer);
  throttledRefreshTimer = setTimeout(() => {
    void refreshGit();
  }, 500);
}

onMounted(() => {
  void refreshGit();
  document.addEventListener('click', onDocumentClick);
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);

  // Refresh git stats in real-time after each tool finishes
  cleanupToolEnd = bridge.onToolEnd((_result) => {
    scheduleRefresh();
  });
});

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick);
  if (clockTimer) clearInterval(clockTimer);
  if (gitTimer) clearInterval(gitTimer);
  if (throttledRefreshTimer) clearTimeout(throttledRefreshTimer);
  if (cleanupToolEnd) cleanupToolEnd();
});

// Periodically refresh git info while the panel is expanded (fallback)
watch(collapsed, (isCollapsed) => {
  if (gitTimer) {
    clearInterval(gitTimer);
    gitTimer = undefined;
  }
  if (!isCollapsed) {
    gitTimer = setInterval(() => {
      void refreshGit();
    }, 15000);
  }
});
</script>

<template>
  <div v-if="showPanel" ref="panelRef" class="git-float">
    <button
      class="git-pill"
      type="button"
      :aria-expanded="!collapsed"
      @click="togglePanel"
    >
      <!-- Plan summary in pill -->
      <template v-if="hasPlan">
        <span class="pill-icon">{{ chatStore.isStreaming ? '🔄' : planAllDone ? '✅' : '📋' }}</span>
        <span class="pill-label">计划</span>
        <span class="pill-progress">{{ planDone }}/{{ planTotal }}</span>
      </template>
      <!-- Git summary in pill -->
      <template v-if="gitStatus.isRepo">
        <span class="pill-sep" v-if="hasPlan">·</span>
        <span class="branch-icon" aria-hidden="true">⑂</span>
        <span class="pill-branch">{{ gitStatus.branch || 'HEAD' }}</span>
        <span v-if="hasChanges" class="pill-dot" />
        <span v-if="hasChanges" class="pill-count">+{{ gitStatus.addedLines }} −{{ gitStatus.deletedLines }}</span>
      </template>
      <span aria-hidden="true">{{ collapsed ? '⌄' : '⌃' }}</span>
    </button>

    <section v-if="!collapsed" class="git-card">
      <!-- ═══ Plan Section ═══ -->
      <template v-if="hasPlan">
        <header class="card-header">
          <span>📋 执行计划</span>
          <span class="card-progress">
            <template v-if="planElapsed">⏱ {{ planElapsed }} · </template>
            {{ planAllDone && !chatStore.isStreaming ? '全部完成 ✅' : `${planDone}/${planTotal} 完成` }}
          </span>
        </header>

        <div class="step-list">
          <div
            v-for="step in visiblePlanSteps"
            :key="step.id"
            class="step-row"
            :class="`step-${step.status}`"
          >
            <span class="step-icon" :class="`icon-${step.status}`">{{ planStepIcon(step.status) }}</span>
            <span class="step-desc">{{ step.description }}</span>
            <span v-if="step.result" class="step-result">{{ step.result }}</span>
          </div>
        </div>

        <button
          v-if="hiddenPlanCount > 0"
          class="show-more-btn"
          @click="showAllPlan = !showAllPlan"
        >
          {{ showAllPlan ? '收起' : `展开全部 (还有 ${hiddenPlanCount} 项)` }}
        </button>

        <div v-if="gitStatus.isRepo" class="section-divider" />
      </template>

      <!-- ═══ Git Section ═══ -->
      <template v-if="gitStatus.isRepo">
        <header class="card-header">
          <span>Git 工具</span>
          <button type="button" class="icon-button" aria-label="刷新 Git 信息" @click="refreshGit">↻</button>
        </header>

        <div class="info-row">
          <span>▣　更改</span>
          <span class="line-stats">
            <strong class="added">+{{ gitStatus.addedLines }}</strong>
            <strong class="deleted">-{{ gitStatus.deletedLines }}</strong>
          </span>
        </div>
        <div class="info-row"><span>⑂　{{ gitStatus.branch || 'HEAD' }}</span></div>
        <button type="button" class="commit-row" title="创建提交" @click="toggleCommitForm">
          <span>─　提交</span><span>{{ showCommitForm ? '收起' : '•••' }}</span>
        </button>

        <div v-if="showCommitForm" class="commit-form">
          <textarea v-model="commitMessage" class="commit-textarea" placeholder="输入提交信息（留空可点 AI 生成）" rows="3" />
          <div class="commit-actions">
            <button type="button" class="ai-gen-btn" :disabled="generatingCommitMsg" @click="generateCommitMessage">
              {{ generatingCommitMsg ? '⚡ 生成中...' : '🤖 AI 生成' }}
            </button>
            <button type="button" class="commit-submit-btn" :disabled="committing" @click="doCommit">
              {{ committing ? '⏳ 提交中...' : '提交' }}
            </button>
          </div>
          <div v-if="commitFeedback" class="commit-feedback">{{ commitFeedback }}</div>
        </div>

        <div class="section-divider" />
      </template>

      <!-- ═══ Process Section ═══ -->
      <section class="process-section">
        <div class="section-heading">
          <span>进程</span><span>{{ runningCount }}/{{ sortedProcesses.length }}</span>
        </div>
        <div v-if="processes.length > 0" class="process-list">
          <div
            v-for="proc in sortedProcesses"
            :key="proc.pid"
            class="process-row"
            :title="proc.command"
          >
            <span :class="['status-dot', proc.status]">
              {{ proc.status === 'running' ? '●' : proc.status === 'completed' ? '✓' : '×' }}
            </span>
            <span class="process-command-text">{{ proc.command }}</span>
            <span
              v-if="proc.expectedPorts && proc.expectedPorts.length > 0"
              class="process-ports"
              :class="{ ready: proc.portsReachable && proc.portsReachable.length > 0 }"
            >
              <template v-if="proc.portsReachable && proc.portsReachable.length > 0">
                :{{ proc.portsReachable.join(', ') }}
              </template>
              <template v-else>
                ⟳ :{{ proc.expectedPorts.join(', ') }}
              </template>
            </span>
            <span class="process-time">{{ formatProcessTime(proc) }}</span>
            <button
              v-if="proc.status === 'running'"
              class="process-kill-btn"
              title="停止进程"
              @click.stop="stopProcess(proc.pid)"
            >■</button>
          </div>
        </div>
        <div v-else class="empty-process">暂无运行进程</div>
      </section>

      <div class="section-divider" />
      <footer class="runtime-row">
        <span>{{ runningCount > 0 ? '运行中' : '运行状态' }}</span>
        <span>
          {{ elapsedText }} · {{ runningCount }} 后台
        </span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.git-float {
  position: absolute;
  top: 72px;
  right: 14px;
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
  background: color-mix(in srgb, var(--color-surface) 92%, transparent);
  color: var(--color-text-secondary);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(10px);
}

.git-card {
  width: min(390px, calc(100vw - 40px));
  margin-top: 6px;
  overflow: hidden;
  border: 1px solid var(--border-color-strong);
  border-radius: 16px;
  background: var(--color-surface);
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

/* ── Process list ── */
.process-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
  min-width: 0;
}
.process-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 12px;
}
.process-command-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.process-time {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: var(--font-mono);
}
.process-ports {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: 10px;
  font-family: var(--font-mono);
  margin-left: 4px;
  opacity: 0.7;
}
.process-ports.ready {
  color: var(--color-green);
  opacity: 1;
}
.status-dot {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-size: 10px;
}
.status-dot.running { color: var(--color-accent); }
.status-dot.completed { color: var(--color-green); }
.status-dot.error { color: var(--color-red); }
.process-kill-btn {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--color-red);
  border-radius: 4px;
  background: transparent;
  color: var(--color-red);
  font-size: 9px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.process-kill-btn:hover {
  background: var(--color-red);
  color: #fff;
}
.empty-process {
  color: var(--color-text-muted);
  font-size: 12px;
}

.git-pill:hover,
.icon-button:hover,
.commit-row:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.pill-branch {
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

.process-section { min-width: 0; }

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

.commit-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 14px 12px;
}

.commit-textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-color-strong);
  border-radius: 8px;
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-size: 13px;
  font-family: var(--font-mono);
  resize: vertical;
  min-height: 56px;
}

.commit-textarea::placeholder {
  color: var(--color-text-muted);
}

.commit-textarea:focus {
  outline: none;
  border-color: var(--color-accent);
}

.commit-actions {
  display: flex;
  gap: 8px;
}

.ai-gen-btn,
.commit-submit-btn {
  flex: 1;
  padding: 6px 12px;
  border: 1px solid var(--border-color-strong);
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.ai-gen-btn {
  background: var(--color-surface);
  color: var(--color-accent);
}

.ai-gen-btn:hover:not(:disabled) {
  background: var(--color-surface-hover);
}

.ai-gen-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.commit-submit-btn {
  background: var(--color-accent);
  color: var(--color-bg);
}

.commit-submit-btn:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.commit-submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.commit-feedback {
  font-size: 12px;
  color: var(--color-text-secondary);
  text-align: center;
}

/* ── Plan section ── */

.pill-icon { font-size: 14px; }
.pill-label { font-weight: 600; }
.pill-progress {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-muted);
}
.pill-sep {
  color: var(--border-color-strong);
  font-size: 11px;
}

.card-progress {
  font-size: 11px;
  color: var(--color-text-muted);
}

.step-list {
  display: flex;
  flex-direction: column;
  padding: 4px 0;
}

.step-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 14px;
  font-size: 12px;
  line-height: 1.4;
  transition: background 0.15s;
}

.step-in_progress {
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
}

.step-icon {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-size: 11px;
}

.icon-pending {
  color: var(--color-text-muted);
  opacity: 0.4;
}

.icon-in_progress {
  color: var(--color-accent);
  animation: plan-pulse-right 1.4s ease-in-out infinite;
}

.icon-done {
  color: var(--color-green);
}

@keyframes plan-pulse-right {
  0%, 100% { opacity: 0.5; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1.1); }
}

.step-desc {
  flex: 1;
  min-width: 0;
  color: var(--color-text-secondary);
}

.step-done .step-desc {
  color: var(--color-text-muted);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--color-green) 40%, transparent);
}

.step-in_progress .step-desc {
  color: var(--color-text);
}

.step-result {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--color-text-muted);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.show-more-btn {
  width: 100%;
  padding: 6px 14px;
  border: none;
  border-top: 1px solid var(--border-color);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s;
}

.show-more-btn:hover {
  color: var(--color-accent);
}
</style>
