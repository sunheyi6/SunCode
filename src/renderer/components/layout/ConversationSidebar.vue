<script setup lang="ts">
import type { SessionMeta } from '@shared/types';
import { computed, onMounted, ref } from 'vue';
import { useSessionsStore } from '../../stores/sessions';
import { bridge } from '../../api/bridge';

const sessionsStore = useSessionsStore();
const searchOpen = ref(false);
const searchQuery = ref('');

onMounted(() => {
  void sessionsStore.init();
});

async function handleCreateSession(): Promise<void> {
  const selectedPath = await bridge.selectDirectory();
  if (!selectedPath) return; // User cancelled
  await sessionsStore.createSession(selectedPath);
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
    <div class="sidebar-actions">
      <template v-if="!searchOpen">
        <button class="primary-action" @click="handleCreateSession()">
          <span class="action-icon">＋</span>
          <span>新建对话</span>
        </button>
        <button
          class="icon-action"
          title="全局查询"
          @click="searchOpen = true"
        >
          ⌕
        </button>
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
      <section v-for="group in groupedSessions" :key="group.path" class="project-group">
        <div class="project-heading" :title="group.path">
          <span class="project-icon">◇</span>
          <span class="project-name">{{ projectName(group.path) }}</span>
          <span class="project-count">{{ group.sessions.length }}</span>
        </div>

        <button
          v-for="session in group.sessions"
          :key="session.id"
          class="conversation-item"
          :class="{ active: session.id === sessionsStore.activeSessionId }"
          @click="sessionsStore.selectSession(session.id)"
        >
          <span class="conversation-mark" />
          <span class="conversation-copy">
            <span class="conversation-name">{{ session.name }}</span>
            <span class="conversation-meta">
              {{ session.messageCount }} 条消息 · {{ formatTime(session.updated) }}
            </span>
          </span>
        </button>
      </section>

      <div v-if="groupedSessions.length === 0" class="empty-conversations">
        没有找到匹配的对话
      </div>
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
}

.primary-action:hover { background: var(--color-accent-hover); }
.action-icon { font-size: 18px; line-height: 1; }

.icon-action {
  width: 38px;
  padding: 0;
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 21px;
}

.icon-action:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
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
}

.conversation-item:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.conversation-item.active {
  border-color: color-mix(in srgb, var(--color-accent) 28%, transparent);
  background: color-mix(in srgb, var(--color-accent) 11%, var(--color-surface));
  color: var(--color-text);
}

.conversation-mark {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--color-overlay);
}
.conversation-item.active .conversation-mark {
  background: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent);
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
.conversation-meta {
  color: var(--color-text-muted);
  font-size: 10px;
}

.empty-conversations {
  padding: 36px 12px;
  color: var(--color-text-muted);
  text-align: center;
  font-size: 12px;
}
</style>
