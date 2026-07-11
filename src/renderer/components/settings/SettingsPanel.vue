<script setup lang="ts">
import type { AppSettings, DiscoveredSkill } from '@shared/types';
import { computed, onMounted, ref } from 'vue';
import { bridge } from '../../api/bridge';
import { useSettingsStore } from '../../stores/settings';
import { useStatsStore } from '../../stores/stats';
import { useUpdateStore } from '../../stores/update';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';
import type { IconName } from '../icons/icons';
import BackgroundColorPicker from './BackgroundColorPicker.vue';
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
const loadedSkills = ref<DiscoveredSkill[]>([]);
const enabledSkillCount = computed(
  () =>
    loadedSkills.value.filter(
      (skill) => !settingsStore.settings.disabledSkills?.includes(skill.path),
    ).length,
);

type Section =
  | 'general'
  | 'appearance'
  | 'models'
  | 'behavior'
  | 'mcp'
  | 'skills'
  | 'usage'
  | 'about';
const activeSection = ref<Section>(props.initialSection as Section);

const navItems: { key: Section; label: string; icon: IconName }[] = [
  { key: 'general', label: '常规', icon: 'command' },
  { key: 'appearance', label: '外观', icon: 'palette' },
  { key: 'models', label: '模型设置', icon: 'layers' },
  { key: 'behavior', label: '行为', icon: 'zap' },
  { key: 'mcp', label: 'MCP 服务器', icon: 'plug' },
  { key: 'skills', label: '技能', icon: 'sparkles' },
  { key: 'usage', label: '使用统计', icon: 'activity' },
  { key: 'about', label: '关于', icon: 'info' },
];

/**
 * Popular open-source editor/app background colors (GitHub community themes).
 * Hex values are the official base/canvas backgrounds of each theme.
 */
const BACKGROUND_PRESETS: ReadonlyArray<{ color: string; label: string }> = [
  // Neutrals
  { color: '#000000', label: 'Pure Black' },
  { color: '#FFFFFF', label: 'Pure White' },
  { color: '#1E1E1E', label: 'VS Code Dark+' },
  { color: '#F5F5F7', label: 'Apple Light' },
  // GitHub (primer / github-vscode-theme)
  { color: '#0D1117', label: 'GitHub Dark' },
  { color: '#22272E', label: 'GitHub Dimmed' },
  { color: '#010409', label: 'GitHub Dark HC' },
  { color: '#F6F8FA', label: 'GitHub Light' },
  // Tokyo Night — enkia/tokyo-night-vscode-theme
  { color: '#1A1B26', label: 'Tokyo Night' },
  { color: '#24283B', label: 'Tokyo Night Storm' },
  // Catppuccin — catppuccin/catppuccin
  { color: '#1E1E2E', label: 'Catppuccin Mocha' },
  { color: '#24273A', label: 'Catppuccin Macchiato' },
  { color: '#303446', label: 'Catppuccin Frappé' },
  { color: '#EFF1F5', label: 'Catppuccin Latte' },
  // Classics
  { color: '#282A36', label: 'Dracula' },
  { color: '#282C34', label: 'One Dark' },
  { color: '#2E3440', label: 'Nord' },
  { color: '#272822', label: 'Monokai' },
  { color: '#002B36', label: 'Solarized Dark' },
  { color: '#FDF6E3', label: 'Solarized Light' },
  { color: '#282828', label: 'Gruvbox Dark' },
  { color: '#FBF1C7', label: 'Gruvbox Light' },
  // Rosé Pine — rose-pine/rose-pine-theme
  { color: '#191724', label: 'Rosé Pine' },
  { color: '#232136', label: 'Rosé Pine Moon' },
  { color: '#FAF4ED', label: 'Rosé Pine Dawn' },
  // Ayu — ayu-theme
  { color: '#0B0E14', label: 'Ayu Dark' },
  { color: '#1F2430', label: 'Ayu Mirage' },
  // Night Owl — sdras/night-owl-vscode-theme
  { color: '#011627', label: 'Night Owl' },
  { color: '#FBFBFB', label: 'Night Owl Light' },
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
  void loadSkills();
});

async function loadSkills(): Promise<void> {
  try {
    console.log('[SettingsPanel] loadSkills() called');
    const result = await bridge.getSkills();
    console.log('[SettingsPanel] getSkills() returned:', result.length, 'skills', result);
    loadedSkills.value = result;
  } catch (err) {
    console.error('[SettingsPanel] loadSkills() failed:', err);
    loadedSkills.value = [];
  }
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function isSkillEnabled(path: string): boolean {
  return !settingsStore.settings.disabledSkills?.includes(path);
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function updateSkillEnabled(path: string, enabled: boolean): void {
  const disabled = new Set(settingsStore.settings.disabledSkills ?? []);
  if (enabled) {
    disabled.delete(path);
  } else {
    disabled.add(path);
  }
  void settingsStore.update({ disabledSkills: [...disabled] });
}

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

function updateTaskCompleteNotification(event: Event): void {
  const mode = (event.target as HTMLSelectElement).value as AppSettings['taskCompleteNotification'];
  settingsStore.update({ taskCompleteNotification: mode });
}

function updateCreateGitWorktree(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  settingsStore.update({ createGitWorktree: checked });
}

function updateShowThinking(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  settingsStore.update({ showThinking: checked });
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

const activeBackgroundColor = computed(() => {
  const color = settingsStore.settings.backgroundColor?.trim();
  return color || '';
});

const activePresetLabel = computed(() => {
  const current = activeBackgroundColor.value.toUpperCase();
  if (!current) return '';
  return BACKGROUND_PRESETS.find((p) => p.color.toUpperCase() === current)?.label ?? '';
});

const pickerFallback = computed(() =>
  settingsStore.resolvedTheme === 'light' ? '#F5F5F7' : '#000000',
);

function isPresetActive(color: string): boolean {
  return activeBackgroundColor.value.toUpperCase() === color.toUpperCase();
}

function selectBackgroundPreset(color: string): void {
  settingsStore.setBackgroundColor(color);
}

function updateBackgroundFromPicker(color: string): void {
  settingsStore.setBackgroundColor(color);
}

function resetBackgroundColor(): void {
  settingsStore.setBackgroundColor('');
}
</script>

<template>
  <Teleport to="body">
    <div class="settings-shell">
      <aside class="settings-sidebar">
        <div class="settings-brand">Z</div>

        <button class="back-button" type="button" @click="emit('close')">
          <span aria-hidden="true"><AppIcon name="chevron-left" :size="16" /></span>
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
            <span class="nav-icon" aria-hidden="true">
              <AppIcon :name="item.icon" :size="15" />
            </span>
            <span class="nav-label">{{ item.label }}</span>
          </button>
        </nav>

        <div class="sidebar-footer">
          <button class="account-button" type="button">
            <span class="account-avatar" aria-hidden="true">
              <AppIcon name="plug" :size="14" />
            </span>
            <span>连接使用</span>
          </button>
          <button class="footer-gear" type="button" title="设置">
            <AppIcon name="settings" :size="15" />
          </button>
        </div>
      </aside>

      <main class="settings-main">
        <header class="settings-topbar">
          <button class="window-action close" type="button" title="关闭设置" @click="emit('close')">
            <AppIcon name="x" :size="14" />
          </button>
        </header>

        <div class="settings-page">
          <section class="page-heading">
            <h1>{{ activeTitle }}</h1>
            <div v-if="activeSection === 'appearance'" class="heading-pills">
              <span>{{ themeLabel(settingsStore.settings.theme) }}</span>
              <span>{{ activeBackgroundColor ? activeBackgroundColor : '主题默认' }}</span>
            </div>
          </section>

          <section v-if="activeSection === 'general'" class="settings-stack">
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

          <section v-else-if="activeSection === 'appearance'" class="settings-stack">
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
              <div class="setting-row static bg-color-row">
                <span class="setting-copy">
                  <strong>全局背景色</strong>
                  <small>自定义应用主背景。选择「主题默认」可恢复当前主题配色。</small>
                </span>
                <span class="bg-color-actions">
                  <BackgroundColorPicker
                    :model-value="activeBackgroundColor || pickerFallback"
                    :fallback="pickerFallback"
                    @update:model-value="updateBackgroundFromPicker"
                  />
                  <button
                    class="save-button"
                    type="button"
                    :disabled="!activeBackgroundColor"
                    @click="resetBackgroundColor"
                  >
                    主题默认
                  </button>
                </span>
              </div>

              <div class="bg-palette">
                <button
                  v-for="preset in BACKGROUND_PRESETS"
                  :key="preset.color"
                  type="button"
                  class="bg-swatch"
                  :class="{ active: isPresetActive(preset.color) }"
                  :style="{ background: preset.color }"
                  :title="`${preset.label} · ${preset.color}`"
                  :aria-label="`背景色 ${preset.label}`"
                  :aria-pressed="isPresetActive(preset.color)"
                  @click="selectBackgroundPreset(preset.color)"
                />
              </div>

              <div v-if="activeBackgroundColor" class="bg-color-meta">
                当前：
                <strong v-if="activePresetLabel">{{ activePresetLabel }}</strong>
                <code>{{ activeBackgroundColor }}</code>
              </div>
            </div>
          </section>

          <section v-else-if="activeSection === 'models'" class="settings-stack">
            <ModelSelector />
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

              <label class="setting-row toggle-row">
                <span class="setting-copy">
                  <strong>显示思考过程</strong>
                  <small>关闭后聊天界面不展示模型的推理/思考文字，仅保留工具与命令执行轨迹。</small>
                </span>
                <label class="toggle-switch">
                  <input
                    type="checkbox"
                    :checked="settingsStore.settings.showThinking ?? true"
                    @change="updateShowThinking"
                  />
                  <span class="toggle-slider" />
                </label>
              </label>
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

            <div class="settings-card">
              <label class="setting-row">
                <span class="setting-copy">
                  <strong>任务完成通知</strong>
                  <small>Agent 完成任务时的通知方式。</small>
                </span>
                <select
                  class="setting-select"
                  :value="settingsStore.settings.taskCompleteNotification ?? 'never'"
                  @change="updateTaskCompleteNotification"
                >
                  <option value="never">不通知</option>
                  <option value="always">始终通知</option>
                  <option value="unfocused">应用失焦时通知</option>
                </select>
              </label>
            </div>

            <div class="settings-card">
              <label class="setting-row toggle-row">
                <span class="setting-copy">
                  <strong>新建对话创建 Git Worktree</strong>
                  <small>开启后，每次新建对话自动创建独立的 Git 工作目录，避免分支污染。</small>
                </span>
                <label class="toggle-switch">
                  <input
                    type="checkbox"
                    :checked="settingsStore.settings.createGitWorktree ?? false"
                    @change="updateCreateGitWorktree"
                  />
                  <span class="toggle-slider" />
                </label>
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
              </div>

              <div class="settings-card">
                <div class="setting-row static">
                  <span class="setting-copy">
                    <strong>内置技能</strong>
                    <small>{{ loadedSkills.length }} 个已检测技能，{{ enabledSkillCount }} 个已启用。</small>
                  </span>
                </div>
                <div v-if="loadedSkills.length > 0" class="simple-list">
                  <div v-for="skill in loadedSkills" :key="skill.path" class="simple-item">
                    <span>
                      <strong>{{ skill.name }}</strong>
                      <small>{{ skill.description || '无描述' }}</small>
                      <small>{{ skill.source }} · {{ skill.path }}</small>
                    </span>
                    <label class="switch" :title="isSkillEnabled(skill.path) ? '已启用' : '已停用'">
                      <input
                        type="checkbox"
                        :checked="isSkillEnabled(skill.path)"
                        @change="updateSkillEnabled(skill.path, ($event.target as HTMLInputElement).checked)"
                      />
                      <span></span>
                    </label>
                  </div>
                </div>
                <p v-else class="empty-text">正在加载…</p>
              </div>

              <div class="settings-card">
                <label class="setting-row static">
                  <span class="setting-copy">
                    <strong>已配置额外技能目录</strong>
                    <small>{{ settingsStore.settings.skills.length }} 个目录。</small>
                  </span>
                </label>
                <div v-if="settingsStore.settings.skills.length > 0" class="simple-list">
                  <div v-for="skill in settingsStore.settings.skills" :key="skill" class="simple-item">
                    <span>
                      <strong>{{ skill }}</strong>
                    </span>
                    <span class="status-pill">外部</span>
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
  /* Frameless window: prevent slider/switch drag from moving the window. */
  -webkit-app-region: no-drag;
  app-region: no-drag;
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
  border-radius: var(--border-radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-size: 14px;
  font-weight: 800;
  line-height: 1;
}

.back-button,
.nav-item,
.account-button,
.footer-gear,
.window-action,
.settings-page,
.settings-page input,
.settings-page button,
.settings-page select,
.settings-page label,
.settings-page .switch,
.settings-page .toggle-switch,
.settings-page .range-control,
.settings-sidebar {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.back-button {
  display: flex;
  width: 100%;
  height: 34px;
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
  font-size: 16px;
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
  height: 34px;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  padding: 0 14px;
  background: transparent;
  color: var(--color-text);
  font-size: 14px;
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
  display: inline-flex;
  width: 22px;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
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
  font-size: 14px;
  font-weight: 600;
}

.account-avatar {
  display: flex;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-color-strong);
  border-radius: 50%;
  background: var(--color-surface);
  color: var(--color-text);
}

.footer-gear {
  width: 34px;
  height: 34px;
  padding: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 14px;
}

.footer-gear:hover {
  background: var(--color-surface);
  color: var(--color-text);
}

.settings-main {
  position: relative;
  min-width: 0;
  overflow: hidden;
  border-top-left-radius: var(--border-radius-lg);
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
  border-radius: var(--border-radius-pill);
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
  border-radius: var(--border-radius-lg);
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
  height: 34px;
  border: 1px solid var(--border-color-strong);
  border-radius: var(--border-radius);
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

/* ── Range slider (modern track + thumb, common open-source pattern) ── */

.range-control {
  display: flex;
  width: min(320px, 40vw);
  align-items: center;
  gap: 14px;
}

.range-control input[type='range'] {
  flex: 1;
  height: 22px;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;
  /* Must stay no-drag or thumb drag moves the frameless window. */
  -webkit-app-region: no-drag;
  app-region: no-drag;
  touch-action: none;
  pointer-events: auto;
}

.range-control input[type='range']:focus {
  outline: none;
}

.range-control input[type='range']:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 45%, transparent);
  outline-offset: 4px;
  border-radius: 999px;
}

/* Track — WebKit */
.range-control input[type='range']::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-muted) 28%, var(--color-bg-tertiary));
}

/* Thumb — WebKit */
.range-control input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  margin-top: -6px;
  border: 0;
  border-radius: 50%;
  background: #ffffff;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.06),
    0 1px 3px rgba(0, 0, 0, 0.22),
    0 2px 8px rgba(0, 0, 0, 0.12);
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.range-control input[type='range']:hover::-webkit-slider-thumb {
  transform: scale(1.06);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.24),
    0 0 0 4px color-mix(in srgb, var(--color-accent) 18%, transparent);
}

.range-control input[type='range']:active::-webkit-slider-thumb {
  transform: scale(0.98);
}

/* Track / thumb — Firefox */
.range-control input[type='range']::-moz-range-track {
  height: 6px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-muted) 28%, var(--color-bg-tertiary));
}

.range-control input[type='range']::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 50%;
  background: #ffffff;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.06),
    0 1px 3px rgba(0, 0, 0, 0.22),
    0 2px 8px rgba(0, 0, 0, 0.12);
}

.range-control span {
  min-width: 50px;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 13px;
  text-align: right;
}

/*
 * iOS-style toggle switch (widely used open-source pattern).
 * Soft track, elevated white knob, green when on.
 */
.switch {
  position: relative;
  display: inline-flex;
  width: 51px;
  height: 31px;
  flex: 0 0 auto;
  cursor: pointer;
}

/* Invisible hit target covering the whole control (must not be 0×0). */
.switch input {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.switch span {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-muted) 55%, var(--color-overlay));
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
  pointer-events: none;
  transition: background 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

.switch span::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 27px;
  height: 27px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.16),
    0 2px 6px rgba(0, 0, 0, 0.14);
  content: '';
  transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

.switch input:checked + span {
  background: var(--color-green, #34c759);
  box-shadow: none;
}

.switch input:checked + span::after {
  transform: translateX(20px);
}

.switch input:focus-visible + span {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 50%, transparent);
  outline-offset: 2px;
}

.switch:hover span::after {
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.2),
    0 3px 8px rgba(0, 0, 0, 0.16);
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
  border-radius: var(--border-radius);
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

.badge {
  flex: 0 0 auto;
  padding: 4px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-green) 13%, var(--color-surface));
  color: var(--color-green);
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
  height: 34px;
  flex: 0 0 auto;
  padding: 0 16px;
  border-radius: var(--border-radius-pill);
  background: var(--color-overlay);
  color: var(--color-text);
  font-weight: 600;
}

.save-button:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
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

/* ── Background color palette ── */

.bg-color-row {
  align-items: flex-start;
}

.bg-color-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
}

.bg-palette {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 20px 18px;
}

.bg-swatch {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 2px solid var(--border-color-strong);
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
  cursor: pointer;
  transition:
    transform 0.12s ease,
    border-color 0.12s ease,
    box-shadow 0.12s ease;
}

.bg-swatch:hover {
  transform: scale(1.1);
  border-color: var(--color-text-secondary);
}

.bg-swatch.active {
  border-color: var(--color-accent);
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--color-accent) 35%, transparent),
    inset 0 0 0 1px rgba(0, 0, 0, 0.06);
}

.bg-color-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  padding: 0 20px 18px;
  color: var(--color-text-muted);
  font-size: 13px;
}

.bg-color-meta strong {
  color: var(--color-text-secondary);
  font-weight: 600;
}

.bg-color-meta code {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
}

/* ── Toggle Switch (same iOS-style as .switch) ── */

.toggle-row {
  cursor: default;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 51px;
  height: 31px;
  flex-shrink: 0;
  cursor: pointer;
}

/* Invisible hit target covering the whole control (must not be 0×0). */
.toggle-switch input {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-muted) 55%, var(--color-overlay));
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
  pointer-events: none;
  transition: background 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

.toggle-slider::before {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 27px;
  height: 27px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.16),
    0 2px 6px rgba(0, 0, 0, 0.14);
  content: '';
  transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

.toggle-switch input:checked + .toggle-slider {
  background: var(--color-green, #34c759);
  box-shadow: none;
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(20px);
}

.toggle-switch input:focus-visible + .toggle-slider {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 50%, transparent);
  outline-offset: 2px;
}

.toggle-switch:hover .toggle-slider::before {
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.2),
    0 3px 8px rgba(0, 0, 0, 0.16);
}
</style>
