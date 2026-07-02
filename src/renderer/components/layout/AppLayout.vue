<script setup lang="ts">
import { computed, ref } from 'vue';
import { useConfirmDialog } from '../../composables/useConfirmDialog';
import { useChatStore } from '../../stores/chat';
import { useSessionsStore } from '../../stores/sessions';
import CallTracePanel from '../chat/CallTracePanel.vue';
import ChatPanel from '../chat/ChatPanel.vue';
import ConfirmDialog from '../chat/ConfirmDialog.vue';
import SettingsPanel from '../settings/SettingsPanel.vue';
import ConversationSidebar from './ConversationSidebar.vue';
import GitPanel from './GitPanel.vue';
import ToastContainer from './ToastContainer.vue';

const chatStore = useChatStore();
const sessionsStore = useSessionsStore();

const activeSession = computed(() =>
  sessionsStore.sessions.find((s) => s.id === sessionsStore.activeSessionId),
);

const sidebarCollapsed = ref(false);
const sidebarWidth = ref(320);
const tracePanelWidth = ref(380);
const isResizing = ref(false);
const isResizingTrace = ref(false);
const showSettings = ref(false);
const settingsSection = ref('general');

function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
}

function openSettingsAt(section: string): void {
  settingsSection.value = section;
  showSettings.value = true;
}

// Tool confirmation dialog (confirm_changes permission mode)
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const { confirmState, handleConfirm, handleDeny } = useConfirmDialog();

function startResize(e: MouseEvent): void {
  isResizing.value = true;
  const startX = e.clientX;
  const startWidth = sidebarWidth.value;

  function onMove(moveEvent: MouseEvent): void {
    const delta = moveEvent.clientX - startX;
    sidebarWidth.value = Math.max(260, Math.min(500, startWidth + delta));
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
    if (msgs[i]?.systemPrompt) return msgs[i].systemPrompt ?? '';
  }
  return '';
});
</script>

<template>
  <div class="app-layout">
    <div class="app-main">
      <!-- Sidebar: conversation queue grouped by project -->
      <aside
        class="sidebar"
        :class="{ collapsed: sidebarCollapsed }"
        :style="{ width: sidebarCollapsed ? '48px' : sidebarWidth + 'px' }"
      >
        <ConversationSidebar
          :collapsed="sidebarCollapsed"
          @open-settings="openSettingsAt"
          @toggle-collapse="toggleSidebar"
        />
        <!-- Settings button at bottom of sidebar (hidden when collapsed) -->
        <div v-if="!sidebarCollapsed" class="sidebar-footer">
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
          v-if="chatStore.messages.length > 0"
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
          v-if="activeSession"
          :messages="chatStore.messages"
          :system-prompt="traceSystemPrompt"
          :session-id="sessionsStore.activeSessionId ?? undefined"
          :working-dir="activeSession.workingDirectory"
          :style="{ width: tracePanelWidth + 'px' }"
          @close="chatStore.toggleCallTrace()"
        />
      </template>
    </div>


    <!-- Settings Modal -->
    <SettingsPanel v-if="showSettings" :initial-section="settingsSection" @close="showSettings = false" />

    <!-- Tool Confirmation Dialog -->
    <ConfirmDialog
      :tool-name="confirmState.toolName"
      :description="confirmState.description"
      :visible="confirmState.visible"
      @confirm="handleConfirm"
      @deny="handleDeny"
    />

    <!-- Toast Notifications -->
    <ToastContainer />
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--color-bg-secondary);
}

.app-main {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* Sidebar */
.sidebar {
  background: #e9e9ec;
  overflow: hidden;
  flex-shrink: 0;
  user-select: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #d7d7dc;
  transition: width 0.2s ease;
}

.sidebar.collapsed {
  overflow: visible;
}

/* Settings button at sidebar bottom */
.sidebar-footer {
  padding: 8px 10px 10px;
  border-top: 1px solid #d7d7dc;
  background: #e9e9ec;
  flex-shrink: 0;
}

.settings-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: var(--border-radius-sm);
  color: #77777d;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.12s;
}

.settings-btn:hover {
  background: #dedee1;
  color: #252528;
}

.settings-icon {
  font-size: 14px;
}

.settings-label {
  font-weight: 500;
}

/* Resize handle — subtle */
.resize-handle {
  width: 1px;
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
  border-radius: 8px 0 0 8px;
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
