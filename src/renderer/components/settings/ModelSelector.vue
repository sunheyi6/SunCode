<script setup lang="ts">
import type { CustomEndpoint } from '@shared/types';
import { computed, onMounted, ref } from 'vue';
import { BUILTIN_PROVIDERS, useModelsStore } from '../../stores/models';
import { useSettingsStore } from '../../stores/settings';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';
import CustomEndpoints from './CustomEndpoints.vue';

const modelsStore = useModelsStore();
const settingsStore = useSettingsStore();

const activeSource = ref<'builtin' | 'custom'>('builtin');
const selectedProvider = ref('');
const searchQuery = ref('');

const builtinProviderSet = new Set(BUILTIN_PROVIDERS);

// 内联 Key 输入状态
const keyInputProvider = ref('');
const keyInputValue = ref('');
const keyInputSaving = ref(false);
const keyInputError = ref('');
const keyInputSaved = ref(false); // 成功提示
const pendingModel = ref<{ provider: string; model: string } | null>(null);

onMounted(() => {
  modelsStore.initAll();
});

const displayModels = computed(() => {
  const q = searchQuery.value.toLowerCase();
  let source: Array<{ provider: string; model: string; label: string }>;

  if (selectedProvider.value) {
    source = modelsStore.providerModels.get(selectedProvider.value) || [];
  } else {
    // 全部内置模型（自定义端点走单独的「自定义模型」tab）
    source = modelsStore.allModels.filter((m) => builtinProviderSet.has(m.provider));
  }

  if (!q) return source;
  return source.filter(
    (m) =>
      m.label.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      m.model.toLowerCase().includes(q),
  );
});

const builtinProviders = computed(() =>
  modelsStore.providers.filter((p) => builtinProviderSet.has(p)),
);

const customEndpoints = computed<CustomEndpoint[]>(
  () => settingsStore.settings.customEndpoints ?? [],
);

const currentModel = computed(() => ({
  provider: modelsStore.activeProvider,
  model: modelsStore.activeModel,
  label: modelsStore.getCurrentLabel(),
}));

const otherModels = computed(() =>
  displayModels.value.filter(
    (model) =>
      model.provider !== modelsStore.activeProvider || model.model !== modelsStore.activeModel,
  ),
);

const enabledProviders = computed(() =>
  modelsStore.enabledProviders.map((provider) => {
    const endpoint = customEndpoints.value.find((ep) => ep.id === provider);
    return {
      id: provider,
      label: endpoint?.name ?? providerLabel(provider),
      modelCount: modelsStore.allModels.filter((model) => model.provider === provider).length,
    };
  }),
);

async function selectProvider(provider: string): Promise<void> {
  selectedProvider.value = provider;
  await modelsStore.loadModels(provider);
}

function selectModel(provider: string, model: string): void {
  // 如果该 provider 没有配置 Key，弹出内联输入框
  if (!modelsStore.hasKey(provider)) {
    openKeyInput(provider, model);
    return;
  }
  modelsStore.selectModel(provider, model);
}

function openKeyInput(provider: string, model?: string): void {
  keyInputProvider.value = provider;
  keyInputValue.value = '';
  keyInputError.value = '';
  keyInputSaved.value = false;
  pendingModel.value = model ? { provider, model } : null;
}

async function saveKey(): Promise<void> {
  const provider = keyInputProvider.value;
  const key = keyInputValue.value.trim();
  if (!key || !provider) return;

  keyInputSaving.value = true;
  keyInputError.value = '';

  try {
    // 直接通过 settings store 保存（走已验证的 settings:update IPC 通道）
    const currentSettings = settingsStore.settings;
    const updatedKeys = { ...currentSettings.envApiKeys, [provider]: key };
    await settingsStore.update({ envApiKeys: updatedKeys });

    // 同时调用专用 setApiKey 设置环境变量
    try {
      await modelsStore.setApiKey(provider, key);
    } catch {
      // 环境变量设置失败不影响主流程
    }

    // 刷新 Key 状态
    await modelsStore.refreshKeyStatus();

    // 显示成功提示
    keyInputSaved.value = true;

    // 如果是从模型选择触发，则保存后切换到目标模型。
    setTimeout(() => {
      if (pendingModel.value) {
        modelsStore.selectModel(pendingModel.value.provider, pendingModel.value.model);
      }
      keyInputProvider.value = '';
      keyInputValue.value = '';
      keyInputSaved.value = false;
      pendingModel.value = null;
    }, 600);
  } catch (e) {
    keyInputError.value = `保存失败：${(e as Error).message || '未知错误'}`;
  } finally {
    keyInputSaving.value = false;
  }
}

function cancelKeyInput(): void {
  keyInputProvider.value = '';
  keyInputValue.value = '';
  keyInputError.value = '';
  pendingModel.value = null;
}

function isActive(provider: string, model: string): boolean {
  return provider === modelsStore.activeProvider && model === modelsStore.activeModel;
}

function isLoading(provider: string): boolean {
  return modelsStore.loadingProviders.has(provider);
}

function providerLabel(id: string): string {
  const map: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    deepseek: 'DeepSeek',
    xai: 'xAI',
    groq: 'Groq',
    mistral: 'Mistral',
    openrouter: 'OpenRouter',
    together: 'Together',
    fireworks: 'Fireworks',
    cerebras: 'Cerebras',
    'kimi-coding': 'Kimi',
    moonshotai: 'Moonshot',
    minimax: 'MiniMax',
  };
  return map[id] || id;
}
</script>

<template>
  <div class="model-selector">
    <section class="active-model-card">
      <div class="active-model-heading">
        <span class="active-indicator" />
        <span>当前启用</span>
        <span class="active-badge">运行中</span>
      </div>
      <div class="active-model-content">
        <div class="active-model-info">
          <strong>{{ currentModel.label }}</strong>
          <span>{{ providerLabel(currentModel.provider) }} · {{ currentModel.model }}</span>
        </div>
        <div class="active-model-actions">
          <span
            class="active-key-status"
            :class="{ configured: modelsStore.hasKey(currentModel.provider) }"
          >
            <template v-if="modelsStore.hasKey(currentModel.provider)">
              <AppIcon name="check" :size="12" /> 密钥已配置
            </template>
            <template v-else>
              <AppIcon name="alert-triangle" :size="12" /> 缺少密钥
            </template>
          </span>
          <button class="manage-key-btn" @click="openKeyInput(currentModel.provider)">
            {{ modelsStore.hasKey(currentModel.provider) ? '修改密钥' : '配置密钥' }}
          </button>
        </div>
      </div>
    </section>

    <!-- ====== 内联 Key 输入框（紧跟在当前模型卡片下方） ====== -->
    <div v-if="keyInputProvider" class="inline-key-input">
      <div class="inline-key-header">
        <span>
          <AppIcon name="key" :size="13" />
          配置 {{ providerLabel(keyInputProvider) }} API Key
        </span>
        <button class="close-btn-sm" @click="cancelKeyInput" aria-label="关闭">
          <AppIcon name="x" :size="13" />
        </button>
      </div>
      <p class="inline-key-hint">
        使用此模型需要 API Key，Key 仅保存在本地。
      </p>

      <!-- 成功提示 -->
      <div v-if="keyInputSaved" class="key-saved-msg">
        <AppIcon name="check" :size="13" /> Key 已保存，正在切换模型...
      </div>

      <!-- 错误提示 -->
      <div v-if="keyInputError" class="key-error-msg">{{ keyInputError }}</div>

      <div v-if="!keyInputSaved" class="inline-key-row">
        <input
          v-model="keyInputValue"
          class="inline-key-field"
          type="password"
          placeholder="粘贴 API Key..."
          @keyup.enter="saveKey"
          @keyup.escape="cancelKeyInput"
          autofocus
        />
        <button
          class="save-key-btn"
          :disabled="!keyInputValue.trim() || keyInputSaving"
          @click="saveKey"
        >
          {{ keyInputSaving ? '保存中...' : '保存并选择' }}
        </button>
      </div>
    </div>

    <div class="list-heading">
      <div>
        <h4>启用的供应商</h4>
        <p>配置过 Key 的供应商会启用，其下所有模型都可在输入框切换。</p>
      </div>
    </div>

    <div class="enabled-provider-list">
      <div v-for="provider in enabledProviders" :key="provider.id" class="enabled-provider">
        <div>
          <strong>{{ provider.label }}</strong>
          <span>{{ provider.id }} · {{ provider.modelCount }} 个模型</span>
        </div>
        <span class="model-key-badge has"><AppIcon name="check" :size="12" /> Key</span>
      </div>
      <div v-if="enabledProviders.length === 0" class="empty-hint">尚未启用供应商。</div>
    </div>

    <div class="list-heading available-heading">
      <div>
        <h4>可用模型</h4>
        <p>同一供应商只需配置一次 Key，点击任意模型即可切换。</p>
      </div>
    </div>

    <!-- 来源切换：内置 / 自定义 -->
    <div class="tab-bar source-tabs">
      <button class="tab-btn" :class="{ active: activeSource === 'builtin' }" @click="activeSource = 'builtin'">
        内置模型
      </button>
      <button class="tab-btn" :class="{ active: activeSource === 'custom' }" @click="activeSource = 'custom'">
        自定义模型
      </button>
    </div>

    <!-- 内置模型 -->
    <template v-if="activeSource === 'builtin'">
      <!-- 搜索 -->
      <div class="search-bar">
        <input v-model="searchQuery" class="search-input" placeholder="搜索模型..." />
      </div>

      <!-- Provider 筛选 -->
      <div class="provider-chips">
        <button
          v-for="provider in builtinProviders"
          :key="provider"
          class="provider-chip"
          :class="{ active: selectedProvider === provider, loading: isLoading(provider) }"
          @click="selectProvider(provider)"
        >
          <span class="chip-key-dot" :class="{ has: modelsStore.hasKey(provider) }" />
          {{ providerLabel(provider) }}
        </button>
      </div>

      <!-- 模型列表 -->
      <div class="model-list">
        <div
          v-for="opt in otherModels"
          :key="`${opt.provider}/${opt.model}`"
          class="model-option"
          :class="{ active: isActive(opt.provider, opt.model) }"
          role="button"
          tabindex="0"
          @click="selectModel(opt.provider, opt.model)"
        >
          <div class="model-main">
            <span class="model-name">{{ opt.label }}</span>
            <div class="model-meta">
              <span class="model-provider">{{ providerLabel(opt.provider) }}</span>
              <span class="model-key-badge" :class="{ has: modelsStore.hasKey(opt.provider) }">
                <template v-if="modelsStore.hasKey(opt.provider)">
                  <AppIcon name="check" :size="12" /> Key
                </template>
                <template v-else>
                  <AppIcon name="alert-triangle" :size="12" /> 需 Key
                </template>
              </span>
            </div>
          </div>
          <span v-if="isActive(opt.provider, opt.model)" class="check-icon">
            <AppIcon name="check" :size="14" />
          </span>
        </div>

        <div v-if="otherModels.length === 0" class="empty-hint">暂无其他模型</div>
      </div>
    </template>
    <!-- 自定义模型 -->
    <template v-else>
      <p class="custom-source-desc">接入 OpenAI / Anthropic 兼容端点。供应商配置 Key 后，其模型会进入输入框切换列表。</p>

      <div v-if="customEndpoints.length === 0" class="empty-hint">
        尚未配置自定义端点。填写下方表单即可添加。
      </div>

      <div v-for="ep in customEndpoints" :key="ep.id" class="custom-group">
        <div class="custom-group-header">
          <span>{{ ep.name }}</span>
          <span class="custom-group-url">{{ ep.baseUrl }}</span>
        </div>
        <div class="model-list">
          <div
            v-for="m in ep.models"
            :key="`${ep.id}/${m.id}`"
            class="model-option"
            :class="{ active: isActive(ep.id, m.id) }"
            role="button"
            tabindex="0"
            @click="selectModel(ep.id, m.id)"
          >
            <div class="model-main">
              <span class="model-name">{{ m.name || m.id }}</span>
              <div class="model-meta">
                <span class="model-provider">{{ ep.id }} · {{ m.id }}</span>
                <span class="model-key-badge has"><AppIcon name="check" :size="12" /></span>
              </div>
            </div>
            <span v-if="isActive(ep.id, m.id)" class="check-icon">
              <AppIcon name="check" :size="14" />
            </span>
          </div>
        </div>
      </div>

      <CustomEndpoints />
    </template>

  </div>
</template>

<style scoped>
.model-selector { display: flex; flex-direction: column; gap: 0; }

.active-model-card {
  padding: 14px;
  margin-bottom: 18px;
  border: 1px solid var(--color-accent);
  border-radius: var(--border-radius-lg);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 13%, transparent), transparent 70%),
    var(--color-surface);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--color-accent) 9%, transparent);
}
.active-model-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
  color: var(--color-accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.active-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-green);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-green) 16%, transparent);
}
.active-badge {
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 999px;
  color: var(--color-green);
  background: color-mix(in srgb, var(--color-green) 13%, transparent);
  font-size: 10px;
}
.active-model-content {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}
.active-model-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 4px;
}
.active-model-info strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.active-model-info span {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}
.active-model-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 8px;
}
.active-key-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-red);
  font-size: 11px;
}
.active-key-status.configured { color: var(--color-green); }
.manage-key-btn {
  padding: 5px 10px;
  border: 1px solid var(--border-color-strong);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-size: 11px;
}
.manage-key-btn:hover { border-color: var(--color-accent); }
.list-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 10px;
}
.available-heading {
  margin-top: 16px;
}
.list-heading h4 {
  margin: 0 0 2px;
  color: var(--color-text);
  font-size: 13px;
}
.list-heading p {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 11px;
}

.tab-bar {
  display: flex; gap: 2px; margin-bottom: 10px;
  border-bottom: 1px solid var(--border-color);
}
.tab-btn {
  flex: 1; padding: 6px 12px; font-size: 13px;
  background: transparent; border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-secondary); cursor: pointer; transition: all 0.15s;
}
.tab-btn:hover { color: var(--color-text); background: var(--color-surface); }
.tab-btn.active { color: var(--color-accent); border-bottom-color: var(--color-accent); }

.source-tabs { margin-bottom: 12px; }
.sub-tabs { margin-bottom: 8px; }
.custom-source-desc { font-size: 12px; color: var(--color-text-muted); margin: 0 0 10px; }
.custom-group { margin-bottom: 14px; }
.custom-group-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.custom-group-header span:first-child { font-size: 13px; font-weight: 600; color: var(--color-text); }
.custom-group-url { font-size: 10px; color: var(--color-text-muted); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.search-bar { margin-bottom: 8px; }
.search-input {
  width: 100%; padding: 6px 10px; font-size: 13px;
  border-radius: var(--border-radius-sm);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--border-color); color: var(--color-text); outline: none;
}
.search-input:focus { border-color: var(--color-accent); }
.search-input::placeholder { color: var(--color-text-muted); }

.provider-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.provider-chip {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 8px; font-size: 11px;
  background: var(--color-surface);
  border: 1px solid var(--border-color); border-radius: var(--border-radius-pill);
  color: var(--color-text-secondary); cursor: pointer; transition: all 0.15s;
}
.provider-chip:hover { background: var(--color-surface-hover); color: var(--color-text); }
.provider-chip.active { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-bg); }
.chip-key-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-red); }
.chip-key-dot.has { background: var(--color-green); }

.model-list {
  display: flex; flex-direction: column; gap: 3px;
  max-height: 280px; overflow-y: auto; padding-right: 2px;
}
.enabled-provider-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.enabled-provider {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
}
.enabled-provider div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.enabled-provider strong {
  color: var(--color-text);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.enabled-provider span {
  color: var(--color-text-muted);
  font-size: 10px;
}

.model-option {
  display: flex; justify-content: space-between; align-items: center;
  padding: 7px 10px;
  background: var(--color-surface);
  border: 1px solid var(--border-color); border-radius: var(--border-radius-sm);
  color: var(--color-text); cursor: pointer; transition: all 0.12s;
  text-align: left; gap: 8px;
}
.model-option:hover { background: var(--color-surface-hover); }
.model-option.active {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-surface));
}

.model-main { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.model-name {
  font-size: 13px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.model-option.active .model-name { color: var(--color-accent); }
.model-meta { display: flex; align-items: center; gap: 6px; }
.model-provider { font-size: 10px; color: var(--color-text-muted); }
.model-key-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 6px;
  color: var(--color-red);
  background: color-mix(in srgb, var(--color-red) 12%, transparent);
}
.model-key-badge.has {
  color: var(--color-green); background: color-mix(in srgb, var(--color-green) 12%, transparent);
}

.check-icon {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  color: var(--color-accent);
}
.empty-hint { padding: 20px; text-align: center; color: var(--color-text-muted); font-size: 13px; }

/* ===== 内联 Key 输入 ===== */
.inline-key-input {
  margin: -4px 0 18px; padding: 12px;
  background: color-mix(in srgb, var(--color-yellow) 8%, var(--color-surface));
  border: 1px solid var(--color-yellow); border-radius: var(--border-radius);
}
.inline-key-header {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 13px; font-weight: 600; color: var(--color-text); margin-bottom: 4px;
}
.close-btn-sm {
  width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 50%; background: transparent;
  color: var(--color-text-muted); font-size: 12px; cursor: pointer;
}
.close-btn-sm:hover { background: var(--color-surface-hover); color: var(--color-text); }
.inline-key-hint { font-size: 11px; color: var(--color-text-muted); margin-bottom: 8px; }

.key-saved-msg {
  padding: 6px 10px; margin-bottom: 8px;
  background: color-mix(in srgb, var(--color-green) 15%, transparent);
  color: var(--color-green); border-radius: var(--border-radius-sm); font-size: 13px;
}
.key-error-msg {
  padding: 6px 10px; margin-bottom: 8px;
  background: color-mix(in srgb, var(--color-red) 15%, transparent);
  color: var(--color-red); border-radius: var(--border-radius-sm); font-size: 13px;
}

.inline-key-row { display: flex; gap: 6px; }
.inline-key-field {
  flex: 1; padding: 6px 10px; font-size: 13px; font-family: var(--font-mono);
  border-radius: var(--border-radius-sm);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--border-color); color: var(--color-text); outline: none;
}
.inline-key-field:focus { border-color: var(--color-accent); }
.save-key-btn {
  padding: 6px 14px; font-size: 13px;
  background: var(--color-accent); color: var(--color-bg);
  border: none; border-radius: var(--border-radius-sm); cursor: pointer; white-space: nowrap;
}
.save-key-btn:hover { opacity: 0.9; }
.save-key-btn:disabled { opacity: 0.4; cursor: not-allowed; }

</style>
