<script setup lang="ts">
import { ref } from 'vue';
import ChatPanel from '../chat/ChatPanel.vue';
import ConversationSidebar from './ConversationSidebar.vue';
import GitPanel from './GitPanel.vue';
import StatusBar from './StatusBar.vue';
import SettingsPanel from '../settings/SettingsPanel.vue';

const sidebarWidth = ref(260);
const isResizing = ref(false);
const showSettings = ref(false);

function startResize(e: MouseEvent): void {
  isResizing.value = true;
  const startX = e.clientX;
  const startWidth = sidebarWidth.value;

  function onMove(moveEvent: MouseEvent): void {
    const delta = moveEvent.clientX - startX;
    sidebarWidth.value = Math.max(180, Math.min(500, startWidth + delta));
  }

  function onUp(): void {
    isResizing.value = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
</script>

<template>
  <div class="app-layout">
    <div class="app-main">
      <!-- Sidebar: conversation queue grouped by project -->
      <aside class="sidebar" :style="{ width: sidebarWidth + 'px' }">
        <ConversationSidebar />
        <!-- Settings button at bottom of sidebar -->
        <div class="sidebar-footer">
          <button class="settings-btn" title="设置 (Ctrl+,)" @click="showSettings = true">
            <span class="settings-icon">⚙️</span>
            <span class="settings-label">设置</span>
          </button>
        </div>
      </aside>

      <!-- Resize handle -->
      <div class="resize-handle" :class="{ active: isResizing }" @mousedown="startResize" />

      <!-- Main: Chat Panel -->
      <main class="main-content">
        <GitPanel />
        <ChatPanel />
      </main>
    </div>

    <!-- Status Bar -->
    <StatusBar />

    <!-- Settings Modal -->
    <SettingsPanel v-if="showSettings" @close="showSettings = false" />
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--color-bg);
}

.app-main {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* Sidebar */
.sidebar {
  background: var(--color-bg-secondary);
  overflow: hidden;
  flex-shrink: 0;
  user-select: none;
  display: flex;
  flex-direction: column;
}

/* Settings button at sidebar bottom */
.sidebar-footer {
  padding: 8px;
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
}

.settings-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: transparent;
  border: none;
  border-radius: var(--border-radius-sm);
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.12s;
}

.settings-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.settings-icon {
  font-size: 15px;
}

.settings-label {
  font-weight: 500;
}

/* Resize handle — subtle */
.resize-handle {
  width: 3px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.2s;
  flex-shrink: 0;
}
.resize-handle:hover,
.resize-handle.active {
  background: var(--color-accent);
  opacity: 0.4;
}

/* Main content area */
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg);
  position: relative;
}
</style>
