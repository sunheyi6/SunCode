import type { AppSettings, CustomEndpoint } from '@shared/types';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { bridge } from '../api/bridge';
import {
  computeCustomEndpointState,
  computeProviderKeyStatus,
  mergeProvidersWithCustom,
} from './custom-endpoints-helpers';
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
  {
    provider: 'google',
    model: 'gemini-3.1-flash-lite-preview',
    label: 'Gemini 3.1 Flash Lite (1M)',
  },
  { provider: 'xai', model: 'grok-code-fast-1', label: 'Grok Code Fast (128K)' },
  { provider: 'xai', model: 'grok-4.3', label: 'Grok 4.3 (128K)' },
  {
    provider: 'mistral',
    model: 'mistral.mistral-large-3-675b-instruct',
    label: 'Mistral Large 3 (128K)',
  },
  {
    provider: 'groq',
    model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    label: 'Llama 4 Maverick (128K)',
  },
  { provider: 'openrouter', model: 'openai/gpt-5.1-codex', label: 'GPT-5.1 Codex (OpenRouter)' },
  {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5 (OpenRouter)',
  },
];

export const BUILTIN_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'xai',
  'groq',
  'mistral',
  'openrouter',
  'together',
  'fireworks',
  'cerebras',
  'kimi-coding',
  'moonshotai',
  'minimax',
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

  const builtinProviderSet = new Set(BUILTIN_PROVIDERS);

  /** 把自定义 endpoint 注入 providers / providerModels / keyStatus，并清理旧的自定义条目。 */
  function syncCustomEndpoints(endpoints: CustomEndpoint[]): void {
    const state = computeCustomEndpointState(endpoints);

    // providers = 内置 + 自定义（去重）
    const customIds = state.providerIds.filter((id) => !builtinProviderSet.has(id));
    providers.value = [...BUILTIN_PROVIDERS, ...customIds];

    // 清理旧的自定义 providerModels，再写入新的
    for (const id of [...providerModels.value.keys()]) {
      if (!builtinProviderSet.has(id)) providerModels.value.delete(id);
    }
    for (const [id, opts] of state.providerModels) providerModels.value.set(id, opts);

    // 清理旧的自定义 keyStatus，再写入新的
    const nextKeyStatus: Record<string, boolean> = {};
    for (const [id, has] of Object.entries(keyStatus.value)) {
      if (builtinProviderSet.has(id)) nextKeyStatus[id] = has;
    }
    for (const [id, has] of Object.entries(state.keyStatus)) nextKeyStatus[id] = has;
    keyStatus.value = nextKeyStatus;
  }

  const allModels = computed<ModelOption[]>(() => {
    const result: ModelOption[] = [...recommendedModels.value];
    for (const models of providerModels.value.values()) result.push(...models);
    return result;
  });

  const switchableModelOptions = computed<ModelOption[]>(() =>
    allModels.value.filter((model) => hasKey(model.provider)),
  );

  const enabledProviders = computed<string[]>(() =>
    mergeProvidersWithCustom(providers.value, [...providerModels.value.keys()]).filter((provider) =>
      hasKey(provider),
    ),
  );

  function hasKey(provider: string): boolean {
    return keyStatus.value[provider] === true;
  }

  /** 从 settingsStore 读取 Key 状态（不依赖 IPC） */
  function syncKeyStatusFromSettings(): void {
    const settingsStore = useSettingsStore();
    keyStatus.value = computeProviderKeyStatus({
      providers: providers.value,
      envApiKeys: settingsStore.settings.envApiKeys || {},
      customEndpoints: settingsStore.settings.customEndpoints ?? [],
    });
  }

  async function refreshKeyStatus(): Promise<void> {
    syncKeyStatusFromSettings();
    try {
      const s = await bridge.getSettings();
      if (s.envApiKeys) {
        keyStatus.value = computeProviderKeyStatus({
          providers: providers.value,
          envApiKeys: s.envApiKeys,
          customEndpoints: s.customEndpoints ?? [],
        });
      }
    } catch {
      /* keep local */
    }
  }

  async function setApiKey(provider: string, key: string): Promise<void> {
    await bridge.setApiKey(provider, key);
    keyStatus.value = { ...keyStatus.value, [provider]: Boolean(key) };
  }

  async function initAll(initialSettings?: AppSettings): Promise<void> {
    syncKeyStatusFromSettings();
    if (isLoaded.value) return;
    isLoaded.value = true;
    if (initialSettings) {
      activeProvider.value = initialSettings.activeProvider;
      activeModel.value = initialSettings.activeModel;
      syncCustomEndpoints(initialSettings.customEndpoints ?? []);
    } else {
      try {
        const s = await bridge.getSettings();
        if (s.activeProvider) activeProvider.value = s.activeProvider;
        if (s.activeModel) activeModel.value = s.activeModel;
        syncCustomEndpoints(s.customEndpoints ?? []);
      } catch {
        /* use defaults */
      }
    }
    loadRecommended().catch(() => {});
    loadProviders().catch(() => {});
  }

  async function loadRecommended(): Promise<void> {
    try {
      const r = await bridge.getRecommendedModels();
      if (r?.length) recommendedModels.value = r;
    } catch {
      /* keep builtin */
    }
  }

  async function loadProviders(): Promise<void> {
    try {
      const p = await bridge.getProviders();
      if (p?.length) {
        const customIds = [...providerModels.value.keys()].filter(
          (id) => !builtinProviderSet.has(id),
        );
        providers.value = mergeProvidersWithCustom(p, customIds);
      }
    } catch {
      /* keep builtin */
    }
  }

  async function loadModels(provider: string): Promise<void> {
    if (providerModels.value.has(provider) || loadingProviders.value.has(provider)) return;
    loadingProviders.value.add(provider);
    try {
      const models = await bridge.getModels(provider);
      if (models?.length) {
        providerModels.value.set(
          provider,
          models.map((m) => ({
            provider: m.provider || provider,
            model: m.id,
            label: `${m.name || m.id} (${((m.contextWindow || 128000) / 1000).toFixed(0)}k)`,
          })),
        );
      }
    } catch {
      providerModels.value.set(provider, []);
    } finally {
      loadingProviders.value.delete(provider);
    }
  }

  async function selectModel(provider: string, model: string): Promise<void> {
    activeProvider.value = provider;
    activeModel.value = model;
    try {
      await bridge.updateSettings({ activeModel: model, activeProvider: provider });
    } catch {
      /* non-fatal */
    }
  }

  function getCurrentLabel(): string {
    const r = recommendedModels.value.find(
      (m) => m.provider === activeProvider.value && m.model === activeModel.value,
    );
    if (r) return r.label;
    const pm = providerModels.value.get(activeProvider.value);
    const m = pm?.find((x) => x.model === activeModel.value);
    return m?.label || `${activeProvider.value}/${activeModel.value}`;
  }

  return {
    activeProvider,
    activeModel,
    providers,
    providerModels,
    enabledProviders,
    switchableModelOptions,
    loadingProviders,
    recommendedModels,
    allModels,
    isLoaded,
    keyStatus,
    hasKey,
    refreshKeyStatus,
    setApiKey,
    syncKeyStatusFromSettings,
    syncCustomEndpoints,
    loadRecommended,
    loadProviders,
    loadModels,
    selectModel,
    getCurrentLabel,
    initAll,
  };
});
