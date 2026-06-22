<script setup lang="ts">
import { ref } from 'vue';
import { useSettingsStore } from '../../stores/settings';
import ModelSelector from './ModelSelector.vue';

const emit = defineEmits<{
  close: [];
}>();

const settingsStore = useSettingsStore();
const activeSection = ref<'model' | 'options'>('model');

function updateThinkingLevel(level: string): void {
  settingsStore.update({
    thinkingLevel: level as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
  });
}

function updateMaxTurns(e: Event): void {
  const val = Number.parseInt((e.target as HTMLInputElement).value, 10);
  if (val > 0 && val <= 200) settingsStore.update({ maxTurns: val });
}

const thinkingLevels = [
  { value: 'minimal', label: '最小', desc: '最快，不思考' },
  { value: 'low', label: '低', desc: '简短思考' },
  { value: 'medium', label: '中等', desc: '平衡（默认）' },
  { value: 'high', label: '高', desc: '深入思考' },
  { value: 'xhigh', label: '最大', desc: '最大程度思考' },
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

        <!-- 标签页 -->
        <div class="section-tabs">
          <button class="section-tab" :class="{ active: activeSection === 'model' }" @click="activeSection = 'model'">
            🧠 模型配置
          </button>
          <button class="section-tab" :class="{ active: activeSection === 'options' }" @click="activeSection = 'options'">
            ⚡ 选项
          </button>
        </div>

        <div class="modal-content">
          <!-- 模型选择 -->
          <section v-if="activeSection === 'model'">
            <ModelSelector />
          </section>

          <!-- 选项 -->
          <section v-if="activeSection === 'options'">
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
  font-size: 16px;
  cursor: pointer;
  transition: all 0.12s;
}
.close-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.section-tabs {
  display: flex;
  padding: 0 20px;
  border-bottom: 1px solid var(--border-color);
  gap: 0;
  flex-shrink: 0;
}
.section-tab {
  padding: 10px 16px;
  font-size: 13px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
}
.section-tab:hover {
  color: var(--color-text);
  background: var(--color-surface);
}
.section-tab.active {
  color: var(--color-accent);
  border-bottom-color: var(--color-accent);
}

.modal-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

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
  font-size: 16px; font-weight: 700;
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
</style>
