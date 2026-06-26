<script setup lang="ts">
import { computed, ref } from 'vue';
import { useChatStore } from '../../stores/chat';
import ChatPanel from '../chat/ChatPanel.vue';
import CallTracePanel from '../chat/CallTracePanel.vue';
import ConversationSidebar from './ConversationSidebar.vue';
import GitPanel from './GitPanel.vue';
import StatusBar from './StatusBar.vue';
import SettingsPanel from '../settings/SettingsPanel.vue';

const chatStore = useChatStore();

const sidebarWidth = ref(260);
const tracePanelWidth = ref(380);
const isResizing = ref(false);
const isResizingTrace = ref(false);
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

function startTraceResize(e: MouseEvent): void {
  isResizingTrace.value = true;
  const startX = e.clientX;
  const startWidth = tracePanelWidth.value;

  function onMove(moveEvent: MouseEvent): void {
    const delta = startX - moveEvent.clientX;
    tracePanelWidth.value = Math.max(280, Math.min(700, startWidth + delta));
  }

  function onUp(): void {
    isResizingTrace.value = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/** System prompt from the last assistant message. */
const traceSystemPrompt = computed(() => {
  const msgs = chatStore.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.systemPrompt) return msgs[i]!.systemPrompt!;
  }
  return '';
});
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

        <!-- 调用轨迹 右侧边缘竖条标签 -->
        <div
          class="trace-edge-tab"
          :class="{ active: chatStore.showCallTrace }"
          :title="chatStore.showCallTrace ? '关闭调用轨迹' : '打开调用轨迹'"
          @click="chatStore.toggleCallTrace()"
        >
          {{ chatStore.showCallTrace ? '◀' : '调用轨迹' }}
        </div>
      </main>

      <!-- Call Trace Panel (right side) -->
      <template v-if="chatStore.showCallTrace">
        <div
          class="resize-handle trace-resize"
          :class="{ active: isResizingTrace }"
          @mousedown="startTraceResize"
        />
        <CallTracePanel
          :messages="chatStore.messages"
          :system-prompt="traceSystemPrompt"
          :style="{ width: tracePanelWidth + 'px' }"
          @close="chatStore.toggleCallTrace()"
        />
      </template>
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
  font-size: 14px;
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

/* ── 调用轨迹 右侧边缘标签 ── */
.trace-edge-tab {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  padding: 10px 3px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--border-color);
  border-right: none;
  border-radius: 6px 0 0 6px;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 12px;
  writing-mode: vertical-rl;
  letter-spacing: 2px;
  transition: background 0.15s, color 0.15s;
  user-select: none;
}

.trace-edge-tab:hover {
  background: var(--color-surface);
  color: var(--color-text);
}

.trace-edge-tab.active {
  background: color-mix(in srgb, var(--color-accent) 15%, transparent);
  color: var(--color-accent);
  border-color: var(--color-accent);
}
</style>
