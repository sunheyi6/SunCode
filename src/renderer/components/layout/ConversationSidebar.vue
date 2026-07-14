<script setup lang="ts">
import type { SessionMeta } from '@shared/types';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { bridge } from '../../api/bridge';
import { useChatStore } from '../../stores/chat';
import { useSessionsStore } from '../../stores/sessions';
import { useSettingsStore } from '../../stores/settings';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';
import { getVisibleSessionGroups } from './session-list';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import UpdateNotification from './UpdateNotification.vue';

const props = defineProps<{
  collapsed: boolean;
}>();

const emit = defineEmits<{
  openSettings: [section: string];
  toggleCollapse: [];
}>();

const sessionsStore = useSessionsStore();
const chatStore = useChatStore();
const settingsStore = useSettingsStore();
const searchQuery = ref('');
const searchOpen = ref(false);
const searchInputRef = ref<HTMLInputElement>();

watch(searchOpen, async (open) => {
  if (open) {
    await nextTick();
    searchInputRef.value?.focus();
  }
});
const selectMode = ref(false);
const selectedIds = ref<Set<string>>(new Set());

/** Track which folder groups are collapsed. */
const collapsedGroups = ref<Set<string>>(new Set());
const expandedSessionGroups = ref<Set<string>>(new Set());

/** Toggle between flat time-ordered list and folder-grouped view. Default = flat list. */
const groupByFolder = ref(false);

function toggleGroup(path: string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  collapsedGroups.value = next;
}

function showAllSessions(path: string): void {
  const next = new Set(expandedSessionGroups.value);
  next.add(path);
  expandedSessionGroups.value = next;
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
  const nonEmptySessions = sessionsStore.sortedSessions.filter(
    (session) => session.messageCount > 0,
  );
  if (!query) return nonEmptySessions;
  return nonEmptySessions.filter(
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

const visibleGroupedSessions = computed(() =>
  getVisibleSessionGroups(groupedSessions.value, expandedSessionGroups.value),
);

const activeGroupPath = computed(
  () =>
    sessionsStore.sessions.find((session) => session.id === sessionsStore.activeSessionId)
      ?.workingDirectory ?? '',
);

// When entering a conversation, auto-collapse other folder groups
watch(activeGroupPath, (newPath) => {
  if (!newPath) return;
  const next = new Set<string>();
  for (const group of groupedSessions.value) {
    if (group.path !== newPath) {
      next.add(group.path);
    }
  }
  collapsedGroups.value = next;
});

const allDisplayedIds = computed(() => {
  const ids: string[] = [];
  if (groupByFolder.value) {
    for (const group of visibleGroupedSessions.value) {
      for (const s of group.sessions) {
        ids.push(s.id);
      }
    }
  } else {
    for (const s of filteredSessions.value) {
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
  await sessionsStore.deleteSession(id);
}

async function deleteSelected(): Promise<void> {
  if (selectedIds.value.size === 0) return;
  await sessionsStore.deleteSessions([...selectedIds.value]);
  exitSelectMode();
}

async function createSessionInGroup(path: string): Promise<void> {
  await sessionsStore.createSession(path);
}

function groupTone(path: string): string {
  const tones = ['yellow', 'mint', 'blue', 'violet', 'rose'];
  let hash = 0;
  for (const ch of path) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return tones[hash % tones.length] ?? 'yellow';
}

function formatTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return '今天';
  }
  const elapsed = today.getTime() - date.getTime();
  const days = Math.max(1, Math.floor(elapsed / 86_400_000));
  if (days < 30) return `${days}天`;
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
</script>

<template>
  <div class="conversation-sidebar" :class="{ collapsed: props.collapsed }">
    <!-- Collapsed state: only show the app mark as toggle button -->
    <template v-if="props.collapsed">
      <div class="sidebar-collapsed-strip">
        <button class="app-mark app-mark-btn" aria-label="展开侧栏" @click="emit('toggleCollapse')">S</button>
      </div>
    </template>

    <!-- Expanded state: full sidebar -->
    <template v-else>
    <!-- Update prompt: background auto-check shows new-version / progress / ready / error states at top of sidebar -->
    <UpdateNotification />

    <div class="sidebar-actions">
        <div class="sidebar-nav">
          <button class="app-mark app-mark-btn" aria-label="折叠侧栏" @click="emit('toggleCollapse')">S</button>
        </div>

      <div class="command-stack">
        <button class="command-row" @click="handleCreateSession()">
          <span class="command-icon command-plus"><AppIcon name="plus" :size="15" /></span>
          <span class="command-label">新建任务</span>
          <span class="command-shortcut">Ctrl+N</span>
        </button>
        <button
          class="command-row"
          :class="{ active: searchOpen }"
          title="搜索对话"
          @click="searchOpen = !searchOpen"
        >
          <span class="command-icon"><AppIcon name="search" :size="15" /></span>
          <span class="command-label">搜索</span>
          <span class="command-shortcut">Ctrl+K</span>
        </button>
        <button class="command-row" @click="emit('openSettings', 'skills')">
          <span class="command-icon"><AppIcon name="sparkles" :size="15" /></span>
          <span class="command-label">技能</span>
          <span v-if="settingsStore.settings.skills.length > 0" class="command-shortcut">
            {{ settingsStore.settings.skills.length }}
          </span>
        </button>
      </div>

      <div v-if="searchOpen" class="search-row">
        <span class="search-icon"><AppIcon name="search" :size="14" /></span>
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          placeholder="搜索对话..."
          @keyup.escape="searchOpen = false; searchQuery = ''"
        />
        <button v-if="searchQuery" class="search-clear" @click="searchQuery = ''">
          <AppIcon name="x" :size="14" />
        </button>
      </div>

      <div class="scope-toolbar">
        <button
          class="scope-chip"
          :class="{ active: groupByFolder }"
          type="button"
          @click="groupByFolder = !groupByFolder"
        >
          <AppIcon name="folder" :size="13" />
          <span>{{ groupByFolder ? '分组' : '时间' }}</span>
        </button>
        <span class="scope-spacer" />
        <button
          v-if="!selectMode"
          class="scope-icon"
          title="批量管理"
          @click="enterSelectMode()"
        >
          <AppIcon name="list-checks" :size="14" />
        </button>
        <button v-else class="scope-text" @click="exitSelectMode()">取消 {{ selectedIds.size }}</button>
      </div>
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

      <!-- Folder-grouped view -->
      <template v-if="groupByFolder">
        <section
          v-for="group in visibleGroupedSessions"
          :key="group.path"
          class="project-group"
          :class="[
            `tone-${groupTone(group.path)}`,
            { active: group.path === activeGroupPath },
          ]"
        >
          <div
            class="project-heading"
            :class="{ collapsed: collapsedGroups.has(group.path) }"
            :title="group.path"
            @click="toggleGroup(group.path)"
          >
            <span class="project-icon"><AppIcon name="folder" :size="13" /></span>
            <span class="project-name">{{ projectName(group.path) }}</span>
            <span class="project-chevron">
              <AppIcon :name="collapsedGroups.has(group.path) ? 'chevron-right' : 'chevron-down'" :size="13" />
            </span>
            <span class="project-count">{{ group.totalCount }}</span>
            <button
              class="project-add"
              title="在此项目中新建任务"
              @click.stop="createSessionInGroup(group.path)"
            >
              <AppIcon name="plus" :size="13" />
            </button>
          </div>

          <div v-if="!collapsedGroups.has(group.path)" class="project-sessions">
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
                :class="{ running: chatStore.streamingSessionIds.has(session.id) }"
                @click="selectMode ? toggleSelect(session.id) : sessionsStore.selectSession(session.id)"
              >
                <span class="conversation-mark" :class="{ running: chatStore.streamingSessionIds.has(session.id) }" />
                <span class="conversation-name">{{ session.name }}</span>
                <span class="conversation-time">{{ formatTime(session.updated) }}</span>
              </button>

              <!-- Delete button on hover (hidden in select mode) -->
              <button
                v-if="!selectMode"
                class="delete-btn"
                title="删除对话"
                @click.stop="deleteSingle(session.id)"
              >
                <AppIcon name="x" :size="13" />
              </button>
            </div>

            <button
              v-if="group.hiddenCount > 0"
              class="show-more-sessions"
              type="button"
              @click="showAllSessions(group.path)"
            >
              显示其余 {{ group.hiddenCount }} 个对话
            </button>
          </div>
        </section>

        <div v-if="groupedSessions.length === 0" class="empty-conversations">
          没有找到匹配的对话
        </div>
      </template>

      <!-- Flat time-ordered view (default) -->
      <template v-else>
        <div
          v-for="session in filteredSessions"
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
            :class="{ running: chatStore.streamingSessionIds.has(session.id) }"
            @click="selectMode ? toggleSelect(session.id) : sessionsStore.selectSession(session.id)"
          >
            <span class="conversation-mark" :class="{ running: chatStore.streamingSessionIds.has(session.id) }" />
            <span class="conversation-name">{{ session.name }}</span>
            <span class="conversation-time">{{ formatTime(session.updated) }}</span>
          </button>

          <!-- Delete button on hover (hidden in select mode) -->
          <button
            v-if="!selectMode"
            class="delete-btn"
            title="删除对话"
            @click.stop="deleteSingle(session.id)"
          >
            <AppIcon name="x" :size="13" />
          </button>
        </div>

        <div v-if="filteredSessions.length === 0" class="empty-conversations">
          没有找到匹配的对话
        </div>
      </template>
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
    </template>
  </div>
</template>

<style scoped>
.conversation-sidebar {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  padding-top: 6px;
}

/* ── Update prompt: see UpdateNotification.vue ── */

.sidebar-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 62%, transparent);
  -webkit-app-region: drag;
  app-region: drag;
}

.action-row {
  display: flex;
  gap: 4px;
  align-items: center;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.primary-action,
.icon-action {
  height: 34px;
  border: 1px solid transparent;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.primary-action {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: flex-start;
  gap: 7px;
  padding: 0 8px;
  background: transparent;
  color: var(--color-text);
  font-weight: 560;
  transition: background 0.15s ease, color 0.15s ease;
}

.primary-action:hover {
  background: var(--color-surface);
  color: var(--color-text);
}
.action-icon { font-size: 18px; line-height: 1; }

.icon-action {
  width: 32px;
  padding: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 15px;
  transition: background 0.15s ease, color 0.15s ease;
}

.icon-action:hover {
  background: var(--color-surface);
  color: var(--color-text);
}

.icon-action.active {
  background: var(--color-surface);
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
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.text-action:hover {
  color: var(--color-text);
}

.icon-action + .icon-action {
  margin-left: -2px;

}

/* Row 2: Search */
.search-row {
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  transition: border-color 0.15s;
}

.search-row:focus-within {
  border-color: var(--color-accent);
}

.search-icon {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
}

.search-row input {
  min-width: 0;
  flex: 1;
  padding: 6px 0;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font-size: 14px;
  outline: none;
}

.search-row input::placeholder {
  color: var(--color-text-muted);
}

.search-clear {
  padding: 0 2px;
  background: transparent;
  border: 0;
  color: var(--color-text-muted);
  font-size: 14px;
  cursor: pointer;
  flex-shrink: 0;
}

.search-clear:hover {
  color: var(--color-text);
}

.search-close-btn {
  padding: 0 2px;
  background: transparent;
  border: 0;
  color: var(--color-text-muted);
  font-size: 14px;
  cursor: pointer;
  flex-shrink: 0;
}

.search-close-btn:hover {
  color: var(--color-text);
}

/* Row 3: Skills */
.skills-row {
  height: 28px;
  padding: 0 4px;
  color: var(--color-text-muted);
  font-size: 12px;
  cursor: pointer;
  border-radius: var(--border-radius-sm);
  transition: background 0.12s, color 0.12s;
}

.skills-row:hover {
  background: var(--color-surface);
  color: var(--color-text-secondary);
}

.skills-icon {
  font-size: 13px;
  font-weight: 700;
  margin-right: 6px;
  color: var(--color-accent);
}

.skills-label {
  flex: 1;
}

.skills-count {
  min-width: 18px;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-accent) 16%, transparent);
  color: var(--color-accent);
  font-size: 11px;
  font-weight: 600;
  text-align: center;
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
  padding: 10px 8px 12px;
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
  letter-spacing: 0;
  text-transform: uppercase;
  cursor: pointer;
  user-select: none;
  border-radius: var(--border-radius-sm);
  transition: background 0.12s ease, color 0.12s ease;
}

.project-heading:hover {
  background: color-mix(in srgb, var(--color-surface) 74%, transparent);
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
  background: color-mix(in srgb, var(--color-surface) 78%, transparent);
  text-align: center;
  font-size: 10px;
}

.conversation-row {
  display: flex;
  position: relative;
  align-items: center;
  border-radius: var(--border-radius-sm);
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
  padding: 8px 9px 8px 22px;
  border: 1px solid transparent;
  border-left: 2px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  text-align: left;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.conversation-row:hover .conversation-item,
.conversation-row:hover {
  background: color-mix(in srgb, var(--color-surface) 78%, transparent);
  color: var(--color-text);
}

.conversation-row.active {
  background: color-mix(in srgb, var(--color-surface) 92%, var(--color-accent));
}

.show-more-sessions {
  width: 100%;
  margin-top: 4px;
  padding: 7px 9px;
  border: 0;
  border-radius: var(--border-radius-sm);
  background: transparent;
  color: var(--color-accent);
  font-size: 12px;
  text-align: left;
}

.show-more-sessions:hover {
  background: var(--color-surface-hover);
}

.conversation-row.active .conversation-item,
.conversation-item.active {
  border-left-color: var(--color-accent);
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
  color: var(--color-bg);
}

.batch-delete-btn:disabled {
  opacity: 0.35;
}

/* Codex-style project sidebar */
.conversation-sidebar {
  padding-top: 0;
  background: var(--sidebar-panel-bg);
  color: var(--sidebar-panel-text);
}

.sidebar-actions {
  gap: 14px;
  padding: 14px 14px 8px;
  border-bottom: 0;
}

.sidebar-nav {
  display: flex;
  align-items: center;
  gap: 18px;
  height: 30px;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.app-mark {
  display: inline-flex;
  width: 23px;
  height: 23px;
  align-items: center;
  justify-content: center;
  border-radius: var(--border-radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-size: 14px;
  font-weight: 800;
  line-height: 1;
}

.app-mark-btn {
  border: 0;
  cursor: pointer;
  transition: opacity 0.15s ease;
  flex-shrink: 0;
}

.app-mark-btn:hover {
  opacity: 0.85;
}

/* ── Collapsed sidebar strip ── */
.sidebar-collapsed-strip {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 14px;
}

.conversation-sidebar.collapsed {
  overflow: visible;
}

.nav-arrow {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--sidebar-panel-secondary);
  font-size: 20px;
  line-height: 20px;
}

.nav-arrow.muted {
  color: var(--sidebar-panel-muted);
}

.command-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.command-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  min-height: 34px;
  padding: 0 0 0 7px;
  border: 0;
  background: transparent;
  color: var(--sidebar-panel-text);
  text-align: left;
}

.command-row:hover,
.command-row.active {
  background: var(--sidebar-panel-surface);
  color: var(--color-text);
}

.command-icon {
  display: inline-flex;
  width: 22px;
  height: 22px;
  align-items: center;
  justify-content: center;
  color: var(--sidebar-panel-text);
  font-size: 14px;
  line-height: 1;
}

.command-plus {
  font-size: 14px;
}

.command-label {
  min-width: 0;
  overflow: hidden;
  color: var(--sidebar-panel-text);
  font-size: 14px;
  font-weight: 450;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-shortcut {
  color: var(--sidebar-panel-muted);
  font-size: 12px;
}

.search-row {
  height: 34px;
  padding: 0 9px;
  border: 0;
  border-radius: var(--border-radius);
  background: var(--sidebar-panel-surface);
}

.scope-toolbar {
  display: flex;
  align-items: center;
  gap: 7px;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.scope-chip {
  display: inline-flex;
  height: 34px;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--sidebar-panel-secondary);
  font-size: 14px;
}

.scope-chip.active {
  background: var(--sidebar-panel-surface);
  color: var(--sidebar-panel-text);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

.scope-spacer {
  flex: 1;
}

.scope-icon,
.scope-text {
  display: inline-flex;
  min-width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  border: 0;
  border-radius: var(--border-radius-sm);
  background: transparent;
  color: var(--sidebar-panel-secondary);
  font-size: 14px;
}

.scope-text {
  font-size: 14px;
}

.scope-icon:hover,
.scope-text:hover {
  background: var(--sidebar-panel-hover);
}

.conversation-list {
  padding: 12px 12px 14px 18px;
  scrollbar-color: var(--sidebar-panel-muted) transparent;
}

.project-group {
  --project-color: var(--color-yellow);
  position: relative;
}

.project-group + .project-group {
  margin-top: 24px;
}

.project-group.tone-yellow { --project-color: #ffd23f; }
.project-group.tone-mint { --project-color: #58e1bd; }
.project-group.tone-blue { --project-color: #69a7ff; }
.project-group.tone-violet { --project-color: #b893ff; }
.project-group.tone-rose { --project-color: #ff8fa3; }

.project-heading {
  display: grid;
  grid-template-columns: 18px minmax(0, auto) 14px minmax(22px, auto) 18px;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 7px 0 2px;
  border-radius: var(--border-radius-sm);
  color: var(--sidebar-panel-text);
  font-size: 14px;
  font-weight: 450;
  text-transform: none;
}

.project-heading:hover {
  background: color-mix(in srgb, var(--sidebar-panel-hover) 70%, transparent);
  color: var(--sidebar-panel-text);
}

.project-icon {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  align-self: center;
  border-radius: 50%;
  background: var(--project-color);
  color: color-mix(in srgb, #000 65%, var(--project-color));
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
}

.project-name {
  flex: 0 1 auto;
  min-width: 0;
  color: var(--sidebar-panel-text);
  font-size: 14px;
  line-height: 18px;
}

.project-chevron {
  display: inline-flex;
  width: 14px;
  height: 18px;
  align-items: center;
  justify-content: center;
  color: var(--sidebar-panel-muted);
  font-size: 0;
  line-height: 0;
}

.project-chevron::before {
  content: '';
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: translateY(-1px) rotate(45deg);
}

.project-heading.collapsed .project-chevron::before {
  transform: translateX(-1px) rotate(-45deg);
}

.project-count {
  justify-self: end;
  min-width: 22px;
  padding: 1px 6px 2px;
  border-radius: 999px;
  background: var(--sidebar-panel-hover);
  color: var(--sidebar-panel-secondary);
  font-size: 12px;
  font-weight: 450;
}

.project-add {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  justify-self: end;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--sidebar-panel-secondary);
  font-size: 12px;
}

.project-add:hover {
  background: var(--sidebar-panel-surface);
  color: var(--sidebar-panel-text);
}

.project-sessions {
  position: relative;
  margin-top: 7px;
  padding-left: 26px;
}

.project-sessions::before {
  content: '';
  position: absolute;
  left: 14px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--project-color);
}

.conversation-row {
  min-width: 0;
  border-radius: var(--border-radius-sm);
}

.conversation-row + .conversation-row {
  margin-top: 2px;
}

.conversation-row:hover,
.conversation-row:hover .conversation-item {
  background: transparent;
}

.conversation-row.active {
  background: transparent;
}

.conversation-item {
  display: grid;
  grid-template-columns: 6px minmax(0, 1fr) auto;
  gap: 8px;
  min-height: 34px;
  padding: 0 10px 0 8px;
  border: 0;
  border-radius: var(--border-radius-sm);
  color: var(--sidebar-panel-text);
}

.conversation-row:hover .conversation-item {
  background: color-mix(in srgb, var(--sidebar-panel-hover) 70%, transparent);
}

.conversation-row.active .conversation-item,
.conversation-item.active {
  background: var(--sidebar-panel-active);
  color: var(--sidebar-panel-text);
}

.conversation-mark {
  width: 6px;
  height: 6px;
  align-self: center;
  flex-shrink: 0;
  border-radius: 50%;
  background: transparent;
  transition: background 0.2s, box-shadow 0.2s;
}
.conversation-mark.running {
  background: var(--color-green, #22c55e);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-green, #22c55e) 30%, transparent);
  animation: breathe 1.4s ease-in-out infinite;
}

.conversation-name {
  min-width: 0;
  overflow: hidden;
  color: var(--sidebar-panel-text);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-time {
  align-self: center;
  color: var(--sidebar-panel-secondary);
  font-size: 12px;
  line-height: 1;
  transition: opacity 0.12s ease;
}

.conversation-row:hover .conversation-time {
  opacity: 0;
}



.conversation-row .delete-btn {
  top: 50%;
  right: 10px;
  width: 22px;
  height: 22px;
  transform: translateY(-50%);
  border-radius: 50%;
  background: transparent;
  font-size: 13px;
}

.select-all-row {
  padding-left: 8px;
}

.show-more-sessions {
  margin-left: 4px;
  color: var(--sidebar-panel-secondary);
}

.empty-conversations {
  color: var(--sidebar-panel-secondary);
}
</style>
