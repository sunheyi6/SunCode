import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { bridge } from '../api/bridge';
import { useSettingsStore } from './settings';

export interface ModelOption {
  provider: string;
  model: string;
  label: string;
}

const BUILTIN_RECOMMENDED: ModelOption[] = [
  { provider: 'deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro (128K) ⭐默认' },
  { provider: 'deepseek', model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash (128K)' },
  { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (200K)' },
  { provider: 'anthropic', model: 'claude-opus-4-5', label: 'Claude Opus 4.5 (200K)' },
  { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (200K)' },
  { provider: 'openai', model: 'gpt-5.1-codex', label: 'GPT-5.1 Codex (128K)' },
  { provider: 'openai', model: 'gpt-5-codex', label: 'GPT-5 Codex (128K)' },
  { provider: 'openai', model: 'o4-mini', label: 'o4 Mini (200K)' },
  { provider: 'google', model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (1M)' },
  { provider: 'google', model: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite (1M)' },
  { provider: 'xai', model: 'grok-code-fast-1', label: 'Grok Code Fast (128K)' },
  { provider: 'xai', model: 'grok-4.3', label: 'Grok 4.3 (128K)' },
  { provider: 'mistral', model: 'mistral.mistral-large-3-675b-instruct', label: 'Mistral Large 3 (128K)' },
  { provider: 'groq', model: 'meta-llama/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick (128K)' },
  { provider: 'openrouter', model: 'openai/gpt-5.1-codex', label: 'GPT-5.1 Codex (OpenRouter)' },
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (OpenRouter)' },
];

const BUILTIN_PROVIDERS = [
  'anthropic', 'openai', 'google', 'deepseek', 'xai',
  'groq', 'mistral', 'openrouter', 'together', 'fireworks',
  'cerebras', 'kimi-coding', 'moonshotai', 'minimax',
];

export const useModelsStore = defineStore('models', () => {
  const activeProvider = ref('deepseek');
  const activeModel = ref('deepseek-v4-pro');
  const providers = ref<string[]>([...BUILTIN_PROVIDERS]);
  const providerModels = ref<Map<string, ModelOption[]>>(new Map());
  const loadingProviders = ref<Set<string>>(new Set());
  const recommendedModels = ref<ModelOption[]>([...BUILTIN_RECOMMENDED]);
  const isLoaded = ref(false);
  const keyStatus = ref<Record<string, boolean>>({});

  const allModels = computed<ModelOption[]>(() => {
    const result: ModelOption[] = [];
    for (const models of providerModels.value.values()) result.push(...models);
    return result;
  });

  function hasKey(provider: string): boolean {
    return keyStatus.value[provider] === true;
  }

  /** 从 settingsStore 读取 Key 状态（不依赖 IPC） */
  function syncKeyStatusFromSettings(): void {
    const settingsStore = useSettingsStore();
    const keys = settingsStore.settings.envApiKeys || {};
    const status: Record<string, boolean> = {};
    for (const p of providers.value) status[p] = Boolean(keys[p]);
    keyStatus.value = status;
  }

  async function refreshKeyStatus(): Promise<void> {
    syncKeyStatusFromSettings();
    try {
      const s = await bridge.getSettings();
      if (s.envApiKeys) {
        const status: Record<string, boolean> = {};
        for (const p of providers.value) status[p] = Boolean(s.envApiKeys[p]);
        keyStatus.value = status;
      }
    } catch { /* keep local */ }
  }

  async function setApiKey(provider: string, key: string): Promise<void> {
    await bridge.setApiKey(provider, key);
    keyStatus.value = { ...keyStatus.value, [provider]: Boolean(key) };
  }

  async function initAll(): Promise<void> {
    syncKeyStatusFromSettings();
    if (isLoaded.value) return;
    isLoaded.value = true;
    try {
      const s = await bridge.getSettings();
      if (s.activeProvider) activeProvider.value = s.activeProvider;
      if (s.activeModel) activeModel.value = s.activeModel;
    } catch { /* use defaults */ }
    loadRecommended().catch(() => {});
    loadProviders().catch(() => {});
  }

  async function loadRecommended(): Promise<void> {
    try { const r = await bridge.getRecommendedModels(); if (r?.length) recommendedModels.value = r; } catch { /* keep builtin */ }
  }

  async function loadProviders(): Promise<void> {
    try { const p = await bridge.getProviders(); if (p?.length) providers.value = p; } catch { /* keep builtin */ }
  }

  async function loadModels(provider: string): Promise<void> {
    if (providerModels.value.has(provider) || loadingProviders.value.has(provider)) return;
    loadingProviders.value.add(provider);
    try {
      const models = await bridge.getModels(provider);
      if (models?.length) {
        providerModels.value.set(provider, models.map((m) => ({
          provider: m.provider || provider,
          model: m.id,
          label: `${m.name || m.id} (${((m.contextWindow || 128000) / 1000).toFixed(0)}k)`,
        })));
      }
    } catch { providerModels.value.set(provider, []); }
    finally { loadingProviders.value.delete(provider); }
  }

  async function selectModel(provider: string, model: string): Promise<void> {
    activeProvider.value = provider;
    activeModel.value = model;
    try { await bridge.updateSettings({ activeModel: model, activeProvider: provider }); } catch { /* non-fatal */ }
  }

  function getCurrentLabel(): string {
    const r = recommendedModels.value.find((m) => m.provider === activeProvider.value && m.model === activeModel.value);
    if (r) return r.label;
    const pm = providerModels.value.get(activeProvider.value);
    const m = pm?.find((x) => x.model === activeModel.value);
    return m?.label || `${activeProvider.value}/${activeModel.value}`;
  }

  return {
    activeProvider, activeModel, providers, providerModels,
    loadingProviders, recommendedModels, allModels, isLoaded, keyStatus,
    hasKey, refreshKeyStatus, setApiKey, syncKeyStatusFromSettings,
    loadRecommended, loadProviders, loadModels, selectModel,
    getCurrentLabel, initAll,
  };
});
