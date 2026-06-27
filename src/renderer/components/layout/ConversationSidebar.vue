<script setup lang="ts">
import type { SessionMeta } from '@shared/types';
import { computed, onMounted, ref } from 'vue';
import { useSessionsStore } from '../../stores/sessions';
import { useChatStore } from '../../stores/chat';
import { useUpdateStore } from '../../stores/update';
import { bridge } from '../../api/bridge';

const sessionsStore = useSessionsStore();
const chatStore = useChatStore();
const updateStore = useUpdateStore();
const searchOpen = ref(false);
const searchQuery = ref('');
const selectMode = ref(false);
const selectedIds = ref<Set<string>>(new Set());

/** Track which folder groups are collapsed. */
const collapsedGroups = ref<Set<string>>(new Set());

function toggleGroup(path: string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  collapsedGroups.value = next;
}

onMounted(() => {
  void sessionsStore.init();

  // Listen for AI-generated title updates
  bridge.onSessionUpdated((meta) => {
    const idx = sessionsStore.sessions.findIndex((s) => s.id === meta.id);
    if (idx !== -1) {
      sessionsStore.sessions[idx] = meta;
      // Trigger reactivity
      sessionsStore.sessions = [...sessionsStore.sessions];
    }
  });
});

async function handleCreateSession(): Promise<void> {
  const dir = sessionsStore.sessions.find(
    (s) => s.id === sessionsStore.activeSessionId,
  )?.workingDirectory;
  await sessionsStore.createSession(dir);
}

async function handleCreateSessionWithNewFolder(): Promise<void> {
  const dir = await bridge.selectDirectory();
  if (dir) {
    await sessionsStore.createSession(dir);
  }
}

function projectName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || path || '未命名项目';
}

const filteredSessions = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return sessionsStore.sortedSessions;
  return sessionsStore.sortedSessions.filter(
    (session) =>
      session.name.toLowerCase().includes(query) ||
      session.workingDirectory.toLowerCase().includes(query),
  );
});

const groupedSessions = computed(() => {
  const groups = new Map<string, { path: string; sessions: SessionMeta[] }>();
  for (const session of filteredSessions.value) {
    const existing = groups.get(session.workingDirectory);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groups.set(session.workingDirectory, {
        path: session.workingDirectory,
        sessions: [session],
      });
    }
  }
  return [...groups.values()];
});

const allDisplayedIds = computed(() => {
  const ids: string[] = [];
  for (const group of groupedSessions.value) {
    for (const s of group.sessions) {
      ids.push(s.id);
    }
  }
  return ids;
});

const allSelected = computed(() => {
  const ids = allDisplayedIds.value;
  if (ids.length === 0) return false;
  return ids.every((id) => selectedIds.value.has(id));
});

function toggleSelectAll(): void {
  if (allSelected.value) {
    // Deselect all displayed
    for (const id of allDisplayedIds.value) {
      selectedIds.value.delete(id);
    }
  } else {
    // Select all displayed
    for (const id of allDisplayedIds.value) {
      selectedIds.value.add(id);
    }
  }
  // Trigger reactivity
  selectedIds.value = new Set(selectedIds.value);
}

function toggleSelect(id: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedIds.value = next;
}

function enterSelectMode(): void {
  selectMode.value = true;
  selectedIds.value = new Set();
}

function exitSelectMode(): void {
  selectMode.value = false;
  selectedIds.value = new Set();
}

async function deleteSingle(id: string): Promise<void> {
  const confirmed = await bridge.confirm('删除对话', '确定要删除这个对话吗？此操作不可撤销。');
  if (!confirmed) return;
  await sessionsStore.deleteSession(id);
}

async function deleteSelected(): Promise<void> {
  if (selectedIds.value.size === 0) return;
  const count = selectedIds.value.size;
  const confirmed = await bridge.confirm(
    '批量删除对话',
    `确定要删除选中的 ${count} 个对话吗？此操作不可撤销。`,
  );
  if (!confirmed) return;
  await sessionsStore.deleteSessions([...selectedIds.value]);
  exitSelectMode();
}

function formatTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
</script>

<template>
  <div class="conversation-sidebar">
    <!-- Update button: shows at top when update available or downloading -->
    <div
      v-if="updateStore.status.state === 'update-available' || updateStore.status.state === 'downloading'"
      class="update-bar"
    >
      <button
        class="update-btn"
        :disabled="updateStore.status.state === 'downloading'"
        @click="updateStore.startUpdate()"
      >
        <template v-if="updateStore.status.state === 'downloading'">
          <span class="update-spinner" />
          <span>正在更新 {{ Math.round(updateStore.status.downloadProgress ?? 0) }}%</span>
        </template>
        <template v-else>
          <span class="update-icon">⬇</span>
          <span>更新到 {{ updateStore.status.version }}</span>
        </template>
      </button>
    </div>

    <div class="sidebar-actions">
      <template v-if="!searchOpen && !selectMode">
        <button class="primary-action" @click="handleCreateSession()">
          <span class="action-icon">＋</span>
          <span>新建对话</span>
        </button>
        <button
          class="icon-action"
          title="在新文件夹中新建对话"
          @click="handleCreateSessionWithNewFolder"
        >
          📁
        </button>
        <button
          class="icon-action"
          title="全局查询"
          @click="searchOpen = true"
        >
          ⌕
        </button>
        <button
          v-if="sessionsStore.sessions.length > 0"
          class="icon-action"
          title="批量管理"
          @click="enterSelectMode()"
        >
          ☰
        </button>
      </template>
      <template v-else-if="selectMode">
        <span class="select-count">已选 {{ selectedIds.size }} 项</span>
        <button class="text-action" @click="exitSelectMode()">取消</button>
      </template>
      <template v-else>
        <div class="global-search">
          <span>⌕</span>
          <input
            v-model="searchQuery"
            autofocus
            placeholder="查询所有项目和对话..."
            @keyup.escape="searchOpen = false"
          />
          <button v-if="searchQuery" @click="searchQuery = ''">×</button>
          <button class="search-close" @click="searchOpen = false; searchQuery = ''">✕</button>
        </div>
      </template>
    </div>

    <div class="conversation-list">
      <!-- Select all toggle in select mode -->
      <label v-if="selectMode && allDisplayedIds.length > 0" class="select-all-row">
        <input
          type="checkbox"
          :checked="allSelected"
          @change="toggleSelectAll()"
        />
        <span>{{ allSelected ? '取消全选' : '全选' }}</span>
      </label>

      <section v-for="group in groupedSessions" :key="group.path" class="project-group">
        <div
          class="project-heading"
          :class="{ collapsed: collapsedGroups.has(group.path) }"
          :title="group.path"
          @click="toggleGroup(group.path)"
        >
          <span class="project-chevron">{{ collapsedGroups.has(group.path) ? '▶' : '▼' }}</span>
          <span class="project-icon">◇</span>
          <span class="project-name">{{ projectName(group.path) }}</span>
          <span class="project-count">{{ group.sessions.length }}</span>
        </div>

        <template v-if="!collapsedGroups.has(group.path)">
          <div
            v-for="session in group.sessions"
            :key="session.id"
            class="conversation-row"
            :class="{
              active: session.id === sessionsStore.activeSessionId,
              selected: selectedIds.has(session.id),
            }"
          >
            <!-- Checkbox in select mode -->
            <label v-if="selectMode" class="select-checkbox">
              <input
                type="checkbox"
                :checked="selectedIds.has(session.id)"
                @change="toggleSelect(session.id)"
              />
            </label>

            <button
              class="conversation-item"
              @click="selectMode ? toggleSelect(session.id) : sessionsStore.selectSession(session.id)"
            >
              <span class="conversation-mark" :class="{ running: chatStore.streamingSessionIds.has(session.id) }" />
              <span class="conversation-copy">
                <span class="conversation-name">{{ session.name }}</span>
                <span class="conversation-time">{{ formatTime(session.updated) }}</span>
              </span>
            </button>

            <!-- Delete button on hover (hidden in select mode) -->
            <button
              v-if="!selectMode"
              class="delete-btn"
              title="删除对话"
              @click.stop="deleteSingle(session.id)"
            >
              ×
            </button>
          </div>
        </template>
      </section>

      <div v-if="groupedSessions.length === 0" class="empty-conversations">
        没有找到匹配的对话
      </div>
    </div>

    <!-- Batch action bar -->
    <div v-if="selectMode" class="batch-bar">
      <button
        class="batch-delete-btn"
        :disabled="selectedIds.size === 0"
        @click="deleteSelected()"
      >
        删除选中 ({{ selectedIds.size }})
      </button>
    </div>
  </div>
</template>

<style scoped>
.conversation-sidebar {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}

/* ── Update bar ── */
.update-bar {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-bg-secondary));
}

.update-btn {
  width: 100%;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--color-accent);
  border-radius: var(--border-radius-sm);
  background: color-mix(in srgb, var(--color-accent) 14%, var(--color-surface));
  color: var(--color-accent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.update-btn:hover:not(:disabled) {
  background: var(--color-accent);
  color: var(--color-bg);
}

.update-btn:disabled {
  opacity: 0.7;
  cursor: default;
}

.update-icon {
  font-size: 14px;
}

.update-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: update-spin 0.8s linear infinite;
}
@keyframes update-spin {
  to { transform: rotate(360deg); }
}

.sidebar-actions {
  display: flex;
  gap: 6px;
  padding: 10px;
  border-bottom: 1px solid var(--border-color);
}

.primary-action,
.icon-action {
  height: 36px;
  border: 1px solid var(--border-color-strong);
}

.primary-action {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 7px;
  background: var(--color-accent);
  color: var(--color-bg);
  font-weight: 650;
  transition: background 0.15s ease;
}

.primary-action:hover { background: var(--color-accent-hover); }
.action-icon { font-size: 18px; line-height: 1; }

.icon-action {
  width: 38px;
  padding: 0;
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 16px;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.icon-action:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.select-count {
  display: flex;
  flex: 1;
  align-items: center;
  font-size: 13px;
  color: var(--color-accent);
  font-weight: 600;
}

.text-action {
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--border-color-strong);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 13px;
}

.text-action:hover {
  color: var(--color-text);
}

.icon-action + .icon-action {
  margin-left: -2px;

}

.global-search {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 9px;
  border: 1px solid var(--color-accent);
  border-radius: var(--border-radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}

.global-search input {
  min-width: 0;
  flex: 1;
  padding: 7px 0;
  border: 0;
  background: transparent;
}

.global-search button {
  padding: 0 2px;
  background: transparent;
  color: var(--color-text-muted);
}

.search-close {
  font-size: 14px;
  padding: 0 4px;
}

.select-all-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 8px;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.select-all-row input {
  accent-color: var(--color-accent);
}

.conversation-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 7px 12px;
}

.project-group + .project-group { margin-top: 14px; }

.project-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 7px 6px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  cursor: pointer;
  user-select: none;
  border-radius: var(--border-radius-sm);
  transition: background 0.12s ease, color 0.12s ease;
}

.project-heading:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-secondary);
}

.project-chevron {
  font-size: 8px;
  flex-shrink: 0;
  width: 10px;
  text-align: center;
}

.project-icon { color: var(--color-accent); }
.project-name {
  overflow: hidden;
  flex: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-count {
  min-width: 18px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--color-surface);
  text-align: center;
  font-size: 10px;
}

.conversation-row {
  display: flex;
  position: relative;
  align-items: center;
}

.conversation-row .delete-btn {
  display: none;
  position: absolute;
  right: 4px;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 18px;
  line-height: 26px;
}

.conversation-row:hover .delete-btn {
  display: block;
}

.conversation-row .delete-btn:hover {
  color: var(--color-red);
}

.select-checkbox {
  display: flex;
  align-items: center;
  padding-left: 8px;
  cursor: pointer;
}

.select-checkbox input {
  accent-color: var(--color-accent);
}

.conversation-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  text-align: left;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.conversation-row:hover .conversation-item,
.conversation-row:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.conversation-row.active {
  background: color-mix(in srgb, var(--color-accent) 11%, var(--color-surface));
}

.conversation-item.active {
  border-color: color-mix(in srgb, var(--color-accent) 28%, transparent);
  background: transparent;
  color: var(--color-text);
}

.conversation-mark {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--color-overlay);
  transition: background 0.2s, box-shadow 0.2s, opacity 0.3s;
}
.conversation-item.active .conversation-mark {
  background: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent);
}
.conversation-mark.running {
  background: var(--color-green, #22c55e);
  animation: breathe 1.4s ease-in-out infinite;
}
@keyframes breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.7); }
}

.conversation-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}
.conversation-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conversation-time {
  color: var(--color-text-muted);
  font-size: 10px;
  flex-shrink: 0;
  margin-left: auto;
}

.empty-conversations {
  padding: 36px 12px;
  color: var(--color-text-muted);
  text-align: center;
  font-size: 12px;
}

/* Batch action bar */
.batch-bar {
  padding: 10px;
  border-top: 1px solid var(--border-color);
}

.batch-delete-btn {
  width: 100%;
  height: 36px;
  border: 1px solid var(--color-red);
  background: transparent;
  color: var(--color-red);
  font-size: 13px;
  font-weight: 600;
}

.batch-delete-btn:hover:not(:disabled) {
  background: var(--color-red);
  color: #fff;
}

.batch-delete-btn:disabled {
  opacity: 0.35;
}
</style>
