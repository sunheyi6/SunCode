<script setup lang="ts">
import { ref } from 'vue';
import type { AppSettings } from '@shared/types';
import { useSettingsStore } from '../../stores/settings';
import ModelSelector from './ModelSelector.vue';
import TokenUsage from './TokenUsage.vue';

const emit = defineEmits<{
  close: [];
}>();

const settingsStore = useSettingsStore();

type Section = 'model' | 'options' | 'usage';
const activeSection = ref<Section>('model');

const navItems: { key: Section; label: string; icon: string }[] = [
  { key: 'model', label: '模型配置', icon: '🧠' },
  { key: 'options', label: '选项', icon: '⚡' },
  { key: 'usage', label: '用量统计', icon: '📊' },
];

function updateThinkingLevel(level: string): void {
  settingsStore.update({
    thinkingLevel: level as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
  });
}

function updateMaxTurns(e: Event): void {
  const val = Number.parseInt((e.target as HTMLInputElement).value, 10);
  if (val > 0 && val <= 200) settingsStore.update({ maxTurns: val });
}

function updatePermissionMode(mode: AppSettings['permissionMode']): void {
  settingsStore.update({ permissionMode: mode });
}

function updateFontSize(e: Event): void {
  const val = Number.parseInt((e.target as HTMLInputElement).value, 10);
  if (val >= 12 && val <= 20) settingsStore.setFontSize(val);
}

const thinkingLevels = [
  { value: 'minimal', label: '最小', desc: '最快，不思考' },
  { value: 'low', label: '低', desc: '简短思考' },
  { value: 'medium', label: '中等', desc: '平衡（默认）' },
  { value: 'high', label: '高', desc: '深入思考' },
  { value: 'xhigh', label: '最大', desc: '最大程度思考' },
];

const permissionModes = [
  { value: 'plan' as const, label: '计划模式', icon: '📋', desc: '仅规划，不修改文件' },
  { value: 'full_access' as const, label: '完全访问', icon: '🔓', desc: '无限制，可自由读写' },
  { value: 'auto_edit' as const, label: '自动编辑', icon: '✏️', desc: '自动编辑文件无需确认' },
  { value: 'confirm_changes' as const, label: '变更前确认', icon: '✅', desc: '修改前需要用户确认' },
];
</script>

<template>
  <Teleport to="body">
    <div class="settings-backdrop" @click.self="emit('close')">
      <div class="settings-modal">
        <!-- 标题栏 -->
        <div class="modal-header">
          <h2 class="modal-title">⚙️ 设置</h2>
          <button class="close-btn" @click="emit('close')">✕</button>
        </div>

        <!-- 主体：左侧导航 + 右侧内容 -->
        <div class="modal-body">
          <!-- 左侧导航 -->
          <nav class="settings-nav">
            <button
              v-for="item in navItems"
              :key="item.key"
              class="nav-item"
              :class="{ active: activeSection === item.key }"
              @click="activeSection = item.key"
            >
              <span class="nav-icon">{{ item.icon }}</span>
              <span class="nav-label">{{ item.label }}</span>
            </button>
          </nav>

          <!-- 右侧内容 -->
          <div class="settings-content">
            <!-- 模型选择 -->
            <section v-if="activeSection === 'model'">
              <div class="section-title">🧠 模型配置</div>
              <p class="section-desc">选择 AI 提供商和模型</p>
              <ModelSelector />
            </section>

            <!-- 选项 -->
            <section v-if="activeSection === 'options'">
              <div class="section-title">⚡ 选项</div>

              <div class="option-group">
                <h4>思考深度（Reasoning Level）</h4>
                <p class="option-desc">
                  控制模型回答前的"思考"程度。级别越高结果质量越好，但速度更慢、费用更高。
                </p>
                <div class="thinking-options">
                  <button
                    v-for="level in thinkingLevels"
                    :key="level.value"
                    class="thinking-btn"
                    :class="{ active: settingsStore.settings.thinkingLevel === level.value }"
                    @click="updateThinkingLevel(level.value)"
                  >
                    <span class="thinking-label">{{ level.label }}</span>
                    <span class="thinking-desc">{{ level.desc }}</span>
                  </button>
                </div>
              </div>

              <div class="option-group">
                <h4>每轮最大工具调用次数</h4>
                <p class="option-desc">
                  每次请求最多执行多少轮工具调用。值越大可以完成更复杂的任务，但费用也更高。
                </p>
                <div class="turns-control">
                  <input
                    type="range" class="turns-slider" min="1" max="200"
                    :value="settingsStore.settings.maxTurns"
                    @input="(e) => updateMaxTurns(e as unknown as Event)"
                  />
                  <span class="turns-value">{{ settingsStore.settings.maxTurns }}</span>
                </div>
              </div>

              <div class="option-group">
                <h4>字体大小</h4>
                <p class="option-desc">
                  调整界面字体大小。默认为 14px，可调范围 12–20px。
                </p>
                <div class="turns-control">
                  <input
                    type="range" class="turns-slider" min="12" max="20" step="1"
                    :value="settingsStore.settings.fontSize"
                    @input="(e) => updateFontSize(e as unknown as Event)"
                  />
                  <span class="turns-value">{{ settingsStore.settings.fontSize }}px</span>
                </div>
              </div>

              <div class="option-group">
                <h4>主题</h4>
                <div class="theme-options">
                  <button class="theme-btn" :class="{ active: settingsStore.settings.theme === 'system' }" @click="settingsStore.setTheme('system')">
                    <span class="theme-icon">💻</span>
                    <span>跟随系统</span>
                  </button>
                  <button class="theme-btn" :class="{ active: settingsStore.settings.theme === 'dark' }" @click="settingsStore.setTheme('dark')">
                    <span class="theme-icon">🌙</span>
                    <span>暗色</span>
                  </button>
                  <button class="theme-btn" :class="{ active: settingsStore.settings.theme === 'light' }" @click="settingsStore.setTheme('light')">
                    <span class="theme-icon">☀️</span>
                    <span>亮色</span>
                  </button>
                </div>
                <p class="option-desc" style="margin-top:6px;">
                  默认跟随系统主题，并在系统主题变化时自动切换。
                </p>
              </div>

              <div class="option-group">
                <h4>权限模式</h4>
                <p class="option-desc">
                  控制 Agent 对文件的访问和修改权限。
                </p>
                <div class="permission-options">
                  <button
                    v-for="p in permissionModes"
                    :key="p.value"
                    class="perm-btn"
                    :class="{ active: settingsStore.settings.permissionMode === p.value }"
                    @click="updatePermissionMode(p.value)"
                  >
                    <span class="perm-icon">{{ p.icon }}</span>
                    <div class="perm-info">
                      <span class="perm-label">{{ p.label }}</span>
                      <span class="perm-desc">{{ p.desc }}</span>
                    </div>
                  </button>
                </div>
              </div>

              <div class="option-group">
                <h4>自动上下文压缩</h4>
                <p class="option-desc">
                  当对话接近模型上下文限制时，自动总结较早的对话轮次，保持响应快速且节省费用。
                </p>
                <label class="toggle-label">
                  <input type="checkbox" :checked="settingsStore.settings.autoCompact"
                    @change="settingsStore.update({ autoCompact: ($event.target as HTMLInputElement).checked })"
                  />
                  <span>启用自动压缩</span>
                </label>
              </div>
            </section>

            <!-- 用量统计 -->
            <section v-if="activeSection === 'usage'">
              <div class="section-title">📊 用量统计</div>
              <p class="section-desc">按时间和模型维度查看 Token 使用情况</p>
              <TokenUsage />
            </section>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.12s ease;
}
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.settings-modal {
  width: 720px;
  max-height: 80vh;
  background: var(--color-bg);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slideUp 0.2s ease;
}
@keyframes slideUp {
  from { transform: translateY(20px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

/* Header */
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.modal-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}
.close-btn {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.12s;
}
.close-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

/* Body: left nav + right content */
.modal-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* Left nav */
.settings-nav {
  width: 160px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 8px;
  gap: 2px;
  border-right: 1px solid var(--border-color);
  background: var(--color-surface);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: all 0.12s;
}

.nav-item:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.nav-item.active {
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-surface));
  color: var(--color-accent);
  font-weight: 600;
}

.nav-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.nav-label {
  white-space: nowrap;
}

/* Right content */
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  min-width: 0;
}

.section-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
  margin-bottom: 4px;
}

.section-desc {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 16px;
}

/* Options */
.option-group {
  margin-bottom: 20px;
}
.option-group h4 {
  font-size: 13px; font-weight: 600;
  color: var(--color-text);
  margin-bottom: 4px;
}
.option-desc {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 10px;
  line-height: 1.4;
}

.thinking-options {
  display: flex; gap: 4px; flex-wrap: wrap;
}
.thinking-btn {
  flex: 1; min-width: 90px;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 8px;
  background: var(--color-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  color: var(--color-text);
  cursor: pointer;
  transition: all 0.12s;
}
.thinking-btn:hover { background: var(--color-surface-hover); }
.thinking-btn.active {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-bg);
}
.thinking-label { font-size: 12px; font-weight: 600; }
.thinking-desc { font-size: 10px; opacity: 0.7; }

.turns-control {
  display: flex; align-items: center; gap: 12px;
}
.turns-slider { flex: 1; accent-color: var(--color-accent); }
.turns-value {
  font-size: 14px; font-weight: 700;
  color: var(--color-accent);
  min-width: 30px; text-align: center;
}

.theme-options { display: flex; gap: 8px; }
.theme-btn {
  flex: 1;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 10px;
  background: var(--color-surface);
  border: 2px solid var(--border-color);
  border-radius: var(--border-radius);
  color: var(--color-text); font-size: 14px;
  cursor: pointer;
  transition: all 0.12s;
}
.theme-btn:hover { border-color: var(--color-overlay); }
.theme-btn.active {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface));
}
.theme-icon { font-size: 18px; }

.toggle-label {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px;
  color: var(--color-text);
  cursor: pointer;
}
.toggle-label input[type="checkbox"] {
  accent-color: var(--color-accent);
  width: 16px; height: 16px;
}

.permission-options {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.permission-options .perm-btn {
  flex: 1;
  min-width: 120px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--color-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  color: var(--color-text);
  cursor: pointer;
  transition: all 0.12s;
  text-align: left;
}

.permission-options .perm-btn:hover {
  background: var(--color-surface-hover);
}

.permission-options .perm-btn.active {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface));
}

.perm-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.perm-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.perm-label {
  font-size: 13px;
  font-weight: 600;
}

.perm-desc {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 1px;
}
</style>
