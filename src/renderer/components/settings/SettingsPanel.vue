<script setup lang="ts">
import type { AppSettings } from '@shared/types';
import { computed, onMounted, ref } from 'vue';
import { bridge } from '../../api/bridge';
import { useSettingsStore } from '../../stores/settings';
import { useStatsStore } from '../../stores/stats';
import { useUpdateStore } from '../../stores/update';
import CustomEndpoints from './CustomEndpoints.vue';
import ModelSelector from './ModelSelector.vue';
import TokenUsage from './TokenUsage.vue';

const emit = defineEmits<{
  close: [];
}>();

const props = withDefaults(
  defineProps<{
    initialSection?: string;
  }>(),
  {
    initialSection: 'general',
  },
);

const settingsStore = useSettingsStore();
const updateStore = useUpdateStore();
const statsStore = useStatsStore();
const appVersion = ref('');
const logPath = ref('');

type Section = 'general' | 'models' | 'behavior' | 'mcp' | 'skills' | 'usage' | 'about';
const activeSection = ref<Section>(props.initialSection as Section);

const navItems: { key: Section; label: string; icon: string }[] = [
  { key: 'general', label: '常规', icon: '⌘' },
  { key: 'models', label: '模型设置', icon: '▤' },
  { key: 'behavior', label: '行为', icon: '⌁' },
  { key: 'mcp', label: 'MCP 服务器', icon: '⌬' },
  { key: 'skills', label: '技能', icon: '✧' },
  { key: 'usage', label: '使用统计', icon: '▥' },
  { key: 'about', label: '关于', icon: 'ⓘ' },
];

const activeTitle = computed(
  () => navItems.find((item) => item.key === activeSection.value)?.label ?? '设置',
);

const thinkingLevels = [
  { value: 'minimal', label: '最小', desc: '最快，不保留额外推理预算' },
  { value: 'low', label: '低', desc: '轻量思考，适合日常任务' },
  { value: 'medium', label: '中等', desc: '质量和速度的平衡' },
  { value: 'high', label: '高', desc: '复杂问题使用更深推理' },
  { value: 'xhigh', label: '最大', desc: '优先质量，速度和费用更高' },
];

const permissionModes = [
  { value: 'plan' as const, label: '计划模式', desc: '仅规划，不修改文件' },
  { value: 'confirm_changes' as const, label: '变更前确认', desc: '修改前需要用户确认' },
  { value: 'auto_edit' as const, label: '自动编辑', desc: '自动编辑文件，无需逐次确认' },
  { value: 'full_access' as const, label: '完全访问', desc: '允许自由读写和执行命令' },
];

const enabledMcpCount = computed(
  () => settingsStore.settings.mcpServers.filter((server) => server.enabled).length,
);

onMounted(async () => {
  try {
    appVersion.value = await bridge.getAppVersion();
  } catch {
    appVersion.value = '0.1.0';
  }

  try {
    logPath.value = await bridge.getLogPath();
  } catch {
    logPath.value = '';
  }

  void statsStore.loadTokenUsage();
});

function openLogFile(): void {
  if (logPath.value) {
    bridge.showItemInFolder(logPath.value);
  }
}

function updateThinkingLevel(event: Event): void {
  const level = (event.target as HTMLSelectElement).value as AppSettings['thinkingLevel'];
  settingsStore.update({ thinkingLevel: level });
}

function updateMaxTurns(event: Event): void {
  const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
  if (Number.isFinite(value) && value > 0 && value <= 200) {
    settingsStore.update({ maxTurns: value });
  }
}

function updateGoalMaxTurns(event: Event): void {
  const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
  if (Number.isFinite(value) && value > 0 && value <= 50) {
    settingsStore.update({ goalMaxTurns: value });
  }
}

function updateCompactThreshold(event: Event): void {
  const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
  if (Number.isFinite(value) && value >= 50 && value <= 95) {
    settingsStore.update({ compactThreshold: value / 100 });
  }
}

function updateMaxLessons(event: Event): void {
  const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
  if (Number.isFinite(value) && value >= 20 && value <= 1000) {
    settingsStore.update({ maxLessons: value });
  }
}

function updatePermissionMode(event: Event): void {
  const mode = (event.target as HTMLSelectElement).value as AppSettings['permissionMode'];
  settingsStore.update({ permissionMode: mode });
}

function updateWindowsShell(event: Event): void {
  const windowsShell = (event.target as HTMLSelectElement).value as AppSettings['windowsShell'];
  settingsStore.update({ windowsShell });
}

function updateFontSize(event: Event): void {
  const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
  if (Number.isFinite(value) && value >= 12 && value <= 20) {
    settingsStore.setFontSize(value);
  }
}

function updateAutoCompact(event: Event): void {
  settingsStore.update({ autoCompact: (event.target as HTMLInputElement).checked });
}

function themeLabel(theme: AppSettings['theme']): string {
  if (theme === 'system') return '系统';
  if (theme === 'light') return '浅色';
  return '深色';
}
</script>

<template>
  <Teleport to="body">
    <div class="settings-shell">
      <aside class="settings-sidebar">
        <div class="settings-brand">Z</div>

        <button class="back-button" type="button" @click="emit('close')">
          <span aria-hidden="true">‹</span>
          <span>返回工作区</span>
        </button>

        <nav class="settings-nav" aria-label="设置导航">
          <button
            v-for="item in navItems"
            :key="item.key"
            class="nav-item"
            :class="{ active: activeSection === item.key }"
            type="button"
            @click="activeSection = item.key"
          >
            <span class="nav-icon" aria-hidden="true">{{ item.icon }}</span>
            <span class="nav-label">{{ item.label }}</span>
          </button>
        </nav>

        <div class="sidebar-footer">
          <button class="account-button" type="button">
            <span class="account-avatar" aria-hidden="true">◌</span>
            <span>连接使用</span>
          </button>
          <button class="footer-gear" type="button" title="设置">⚙</button>
        </div>
      </aside>

      <main class="settings-main">
        <header class="settings-topbar">
          <button class="window-action close" type="button" title="关闭设置" @click="emit('close')">
            ×
          </button>
        </header>

        <div class="settings-page">
          <section class="page-heading">
            <h1>{{ activeTitle }}</h1>
            <div v-if="activeSection === 'general'" class="heading-pills">
              <span>{{ themeLabel(settingsStore.settings.theme) }}</span>
              <span>系统默认</span>
            </div>
          </section>

          <section v-if="activeSection === 'general'" class="settings-stack">
            <div class="settings-card">
              <label class="setting-row">
                <span class="setting-copy">
                  <strong>界面主题</strong>
                  <small>切换应用界面使用的主题外观。</small>
                </span>
                <select
                  class="setting-select"
                  :value="settingsStore.settings.theme"
                  @change="settingsStore.setTheme(($event.target as HTMLSelectElement).value as AppSettings['theme'])"
                >
                  <option value="system">系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </label>

              <label class="setting-row">
                <span class="setting-copy">
                  <strong>界面字体</strong>
                  <small>调整聊天区域的基础字体大小。</small>
                </span>
                <span class="range-control">
                  <input
                    type="range"
                    min="12"
                    max="20"
                    step="1"
                    :value="settingsStore.settings.fontSize"
                    @input="updateFontSize"
                  />
                  <span>{{ settingsStore.settings.fontSize }}px</span>
                </span>
              </label>
            </div>

            <div class="settings-card">
              <label class="setting-row">
                <span class="setting-copy">
                  <strong>自动上下文压缩</strong>
                  <small>对话接近上下文限制时，自动总结较早内容。</small>
                </span>
                <span class="switch">
                  <input
                    type="checkbox"
                    :checked="settingsStore.settings.autoCompact"
                    @change="updateAutoCompact"
                  />
                  <span />
                </span>
              </label>

              <label class="setting-row">
                <span class="setting-copy">
                  <strong>压缩触发阈值</strong>
                  <small>达到模型上下文窗口的指定比例后触发压缩。</small>
                </span>
                <span class="range-control">
                  <input
                    type="range"
                    min="50"
                    max="95"
                    step="5"
                    :value="Math.round(settingsStore.settings.compactThreshold * 100)"
                    @input="updateCompactThreshold"
                  />
                  <span>{{ Math.round(settingsStore.settings.compactThreshold * 100) }}%</span>
                </span>
              </label>
            </div>
          </section>

          <section v-else-if="activeSection === 'models'" class="settings-stack">
            <ModelSelector />
            <CustomEndpoints />
          </section>

          <section v-else-if="activeSection === 'behavior'" class="settings-stack">
            <div class="settings-card">
              <label class="setting-row">
                <span class="setting-copy">
                  <strong>思考深度</strong>
                  <small>级别越高质量更好，但响应更慢、费用更高。</small>
                </span>
                <select
                  class="setting-select"
                  :value="settingsStore.settings.thinkingLevel"
                  @change="updateThinkingLevel"
                >
                  <option v-for="level in thinkingLevels" :key="level.value" :value="level.value">
                    {{ level.label }}
                  </option>
                </select>
              </label>

              <div class="level-grid">
                <button
                  v-for="level in thinkingLevels"
                  :key="level.value"
                  type="button"
                  class="level-card"
                  :class="{ active: settingsStore.settings.thinkingLevel === level.value }"
                  @click="settingsStore.update({ thinkingLevel: level.value as AppSettings['thinkingLevel'] })"
                >
                  <strong>{{ level.label }}</strong>
                  <span>{{ level.desc }}</span>
                </button>
              </div>
            </div>

            <div class="settings-card">
              <label class="setting-row">
                <span class="setting-copy">
                  <strong>权限模式</strong>
                  <small>控制 Agent 对文件和命令的访问权限。</small>
                </span>
                <select
                  class="setting-select"
                  :value="settingsStore.settings.permissionMode"
                  @change="updatePermissionMode"
                >
                  <option v-for="mode in permissionModes" :key="mode.value" :value="mode.value">
                    {{ mode.label }}
                  </option>
                </select>
              </label>

              <label class="setting-row">
                <span class="setting-copy">
                  <strong>Windows Shell</strong>
                  <small>控制 Agent 在 Windows 上执行命令时使用的 shell。</small>
                </span>
                <select
                  class="setting-select"
                  :value="settingsStore.settings.windowsShell"
                  @change="updateWindowsShell"
                >
                  <option value="auto">自动（优先 Git Bash）</option>
                  <option value="git_bash">Git Bash</option>
                  <option value="powershell">Windows PowerShell</option>
                </select>
              </label>

              <label class="setting-row">
                <span class="setting-copy">
                  <strong>每轮最大工具调用次数</strong>
                  <small>值越大可完成更复杂任务，但也更容易消耗时间和费用。</small>
                </span>
                <span class="number-control">
                  <input
                    type="number"
                    min="1"
                    max="200"
                    :value="settingsStore.settings.maxTurns"
                    @change="updateMaxTurns"
                  />
                </span>
              </label>

              <label class="setting-row">
                <span class="setting-copy">
                  <strong>目标模式最大轮次</strong>
                  <small>控制长目标自动继续的最大轮数。</small>
                </span>
                <span class="number-control">
                  <input
                    type="number"
                    min="1"
                    max="50"
                    :value="settingsStore.settings.goalMaxTurns ?? 5"
                    @change="updateGoalMaxTurns"
                  />
                </span>
              </label>
            </div>
          </section>

          <section v-else-if="activeSection === 'mcp'" class="settings-stack">
            <div class="settings-card">
              <div class="setting-row static">
                <span class="setting-copy">
                  <strong>MCP 服务器</strong>
                  <small>当前配置 {{ settingsStore.settings.mcpServers.length }} 个，其中 {{ enabledMcpCount }} 个已启用。</small>
                </span>
              </div>
              <div v-if="settingsStore.settings.mcpServers.length > 0" class="simple-list">
                <div
                  v-for="server in settingsStore.settings.mcpServers"
                  :key="server.name"
                  class="simple-item"
                >
                  <span>
                    <strong>{{ server.name }}</strong>
                    <small>{{ server.command }} {{ server.args.join(' ') }}</small>
                  </span>
                  <span class="status-pill" :class="{ enabled: server.enabled }">
                    {{ server.enabled ? '已启用' : '已停用' }}
                  </span>
                </div>
              </div>
              <p v-else class="empty-text">暂无 MCP 服务器配置。</p>
            </div>
          </section>

          <section v-else-if="activeSection === 'skills'" class="settings-stack">
            <div class="settings-card">
              <label class="setting-row">
                <span class="setting-copy">
                  <strong>技能记忆数量</strong>
                  <small>控制保留的经验条目数量。</small>
                </span>
                <span class="number-control">
                  <input
                    type="number"
                    min="20"
                    max="1000"
                    :value="settingsStore.settings.maxLessons ?? 200"
                    @change="updateMaxLessons"
                  />
                </span>
              </label>
              <div class="setting-row static">
                <span class="setting-copy">
                  <strong>已配置技能目录</strong>
                  <small>{{ settingsStore.settings.skills.length }} 个目录。</small>
                </span>
              </div>
              <div v-if="settingsStore.settings.skills.length > 0" class="simple-list">
                <div v-for="skill in settingsStore.settings.skills" :key="skill" class="simple-item">
                  <span>
                    <strong>{{ skill }}</strong>
                  </span>
                </div>
              </div>
              <p v-else class="empty-text">暂无额外技能目录。</p>
            </div>
          </section>

          <section v-else-if="activeSection === 'usage'" class="settings-stack">
            <TokenUsage />
          </section>

          <section v-else class="settings-stack">
            <div class="settings-card">
              <div class="setting-row static">
                <span class="setting-copy">
                  <strong>版本</strong>
                  <small>{{ appVersion || '-' }}</small>
                </span>
              </div>
              <div class="setting-row static">
                <span class="setting-copy">
                  <strong>运行日志</strong>
                  <small class="path-text">{{ logPath || '加载中...' }}</small>
                </span>
                <button v-if="logPath" class="save-button" type="button" @click="openLogFile">
                  打开
                </button>
              </div>
            </div>

            <div class="settings-card">
              <div class="setting-row static">
                <span class="setting-copy">
                  <strong>更新</strong>
                  <small>
                    <template v-if="updateStore.status.version">
                      当前最新：{{ updateStore.status.version }}
                    </template>
                    <template v-else>检查是否有新版本可用。</template>
                  </small>
                </span>
                <button
                  class="save-button"
                  type="button"
                  :disabled="updateStore.status.state === 'checking' || updateStore.status.state === 'downloading'"
                  @click="updateStore.checkForUpdates()"
                >
                  <template v-if="updateStore.status.state === 'checking'">检查中</template>
                  <template v-else-if="updateStore.status.state === 'downloading'">
                    {{ Math.round(updateStore.status.downloadProgress ?? 0) }}%
                  </template>
                  <template v-else>检查更新</template>
                </button>
              </div>
              <p v-if="updateStore.status.state === 'no-update'" class="status-note success">
                已是最新版本
              </p>
              <p v-else-if="updateStore.status.state === 'error'" class="status-note error">
                {{ updateStore.status.error || '检查更新失败' }}
              </p>
              <p v-else-if="updateStore.status.state === 'downloaded'" class="status-note success">
                更新已下载，重启后安装
              </p>
            </div>
          </section>
        </div>
      </main>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-shell {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  grid-template-columns: 330px minmax(0, 1fr);
  overflow: hidden;
  background: var(--color-bg);
  color: var(--color-text);
}

.settings-sidebar {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding: 18px 10px 16px;
  border-right: 1px solid var(--border-color);
  background: var(--color-bg-secondary);
}

.settings-brand {
  display: flex;
  width: 23px;
  height: 23px;
  align-items: center;
  justify-content: center;
  margin: 0 0 42px 6px;
  border-radius: 5px;
  background: #0f1115;
  color: #fff;
  font-size: 16px;
  font-weight: 800;
  line-height: 1;
}

.back-button,
.nav-item,
.account-button,
.footer-gear,
.window-action {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.back-button {
  display: flex;
  width: 100%;
  height: 38px;
  align-items: center;
  justify-content: flex-start;
  gap: 9px;
  padding: 0 14px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 14px;
}

.back-button:hover {
  background: color-mix(in srgb, var(--color-surface) 62%, transparent);
  color: var(--color-text);
}

.back-button span:first-child {
  font-size: 24px;
  line-height: 1;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 26px;
}

.nav-item {
  display: flex;
  width: 100%;
  height: 40px;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  padding: 0 14px;
  background: transparent;
  color: var(--color-text);
  font-size: 15px;
  text-align: left;
}

.nav-item:hover {
  background: color-mix(in srgb, var(--color-surface) 62%, transparent);
}

.nav-item.active {
  background: color-mix(in srgb, var(--color-surface) 82%, var(--color-bg-secondary));
  font-weight: 600;
}

.nav-icon {
  width: 18px;
  color: var(--color-text-secondary);
  text-align: center;
}

.nav-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
  padding: 0 10px;
}

.account-button {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  padding: 0;
  background: transparent;
  color: var(--color-text);
  font-size: 15px;
  font-weight: 600;
}

.account-avatar {
  display: flex;
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-color-strong);
  border-radius: 50%;
  background: var(--color-surface);
  color: var(--color-text);
}

.footer-gear {
  width: 32px;
  height: 32px;
  padding: 0;
  background: transparent;
  color: var(--color-text-secondary);
}

.footer-gear:hover {
  background: var(--color-surface);
  color: var(--color-text);
}

.settings-main {
  position: relative;
  min-width: 0;
  overflow: hidden;
  border-top-left-radius: 12px;
  background: var(--color-bg);
}

.settings-topbar {
  display: flex;
  height: 58px;
  align-items: center;
  justify-content: flex-end;
  gap: 18px;
  padding: 0 22px;
  background: var(--color-bg);
  -webkit-app-region: drag;
  app-region: drag;
}

.window-action {
  display: flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  color: var(--color-text);
  font-size: 18px;
}

.window-action:hover {
  background: var(--color-surface-hover);
}

.window-action.close {
  font-size: 24px;
}

.settings-page {
  height: calc(100vh - 58px);
  overflow-y: auto;
  padding: 0 clamp(28px, 4vw, 56px) 56px;
}

.page-heading {
  display: flex;
  min-height: 126px;
  flex-direction: column;
  justify-content: center;
  gap: 18px;
}

.page-heading h1 {
  margin: 0;
  color: var(--color-text);
  font-size: 38px;
  font-weight: 800;
  letter-spacing: 0;
  line-height: 1;
}

.heading-pills {
  display: flex;
  gap: 10px;
}

.heading-pills span {
  padding: 7px 14px;
  border-radius: 10px;
  background: var(--color-surface-hover);
  color: var(--color-text-secondary);
  font-size: 14px;
}

.settings-stack {
  display: flex;
  max-width: 1040px;
  flex-direction: column;
  gap: 20px;
}

.settings-card {
  overflow: hidden;
  border: 1px solid var(--border-color-strong);
  border-radius: 12px;
  background: var(--color-surface);
}

.setting-row {
  display: flex;
  min-height: 86px;
  align-items: center;
  justify-content: space-between;
  gap: 32px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--border-color);
}

.setting-row:last-child {
  border-bottom: 0;
}

.setting-row.static {
  cursor: default;
}

.setting-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 8px;
}

.setting-copy strong {
  color: var(--color-text);
  font-size: 15px;
  font-weight: 560;
}

.setting-copy small {
  color: var(--color-text-muted);
  font-size: 14px;
  line-height: 1.5;
}

.setting-select,
.number-control input {
  width: 240px;
  height: 40px;
  border: 1px solid var(--border-color-strong);
  border-radius: 10px;
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 14px;
}

.setting-select {
  padding: 0 38px 0 14px;
}

.number-control input {
  padding: 0 12px;
}

.range-control {
  display: flex;
  width: min(320px, 40vw);
  align-items: center;
  gap: 14px;
}

.range-control input {
  flex: 1;
  accent-color: var(--color-text);
}

.range-control span {
  min-width: 50px;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 13px;
  text-align: right;
}

.switch {
  position: relative;
  display: inline-flex;
  width: 42px;
  height: 24px;
  flex: 0 0 auto;
}

.switch input {
  position: absolute;
  inset: 0;
  opacity: 0;
}

.switch span {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--color-overlay);
  transition: background 0.15s ease;
}

.switch span::after {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--color-surface);
  content: '';
  transition: transform 0.15s ease;
}

.switch input:checked + span {
  background: #050505;
}

.switch input:checked + span::after {
  transform: translateX(18px);
}

.level-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 10px;
  padding: 0 20px 20px;
}

.level-card {
  display: flex;
  min-height: 74px;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--border-color);
  background: var(--color-bg);
  color: var(--color-text);
  text-align: left;
}

.level-card:hover,
.level-card.active {
  border-color: var(--color-text);
  background: var(--color-surface-hover);
}

.level-card span {
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.35;
}

.simple-list {
  display: flex;
  flex-direction: column;
}

.simple-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 14px 20px;
  border-top: 1px solid var(--border-color);
}

.simple-item span:first-child {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.simple-item strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.simple-item small,
.path-text {
  overflow-wrap: anywhere;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 12px;
}

.status-pill {
  flex: 0 0 auto;
  padding: 4px 9px;
  border-radius: 999px;
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  font-size: 12px;
}

.status-pill.enabled {
  background: color-mix(in srgb, var(--color-green) 13%, var(--color-surface));
  color: var(--color-green);
}

.empty-text,
.status-note {
  margin: 0;
  padding: 0 20px 20px;
  color: var(--color-text-muted);
  font-size: 14px;
}

.status-note {
  padding-top: 0;
}

.status-note.success {
  color: var(--color-green);
}

.status-note.error {
  color: var(--color-red);
}

.save-button {
  height: 38px;
  flex: 0 0 auto;
  padding: 0 16px;
  border-radius: 10px;
  background: #737373;
  color: #fff;
  font-weight: 600;
}

.save-button:hover:not(:disabled) {
  background: #5f5f5f;
}

.save-button:disabled {
  opacity: 0.55;
  cursor: default;
}

@media (max-width: 900px) {
  .settings-shell {
    grid-template-columns: 240px minmax(0, 1fr);
  }

  .setting-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 14px;
  }

  .setting-select,
  .number-control,
  .number-control input,
  .range-control {
    width: 100%;
  }
}
</style>
