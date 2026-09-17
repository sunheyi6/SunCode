import { useSettingsStore } from '../../src/renderer/stores/settings';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateEndpointId, validateEndpoint } from '../../src/renderer/components/settings/custom-endpoints';
import { BUILTIN_PROVIDERS, modelFamily, useModelsStore } from '../../src/renderer/stores/models';

const bridgeMocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getModels: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../../src/renderer/api/bridge', () => ({
  bridge: {
    getProviders: bridgeMocks.getProviders,
    getModels: bridgeMocks.getModels,
    updateSettings: bridgeMocks.updateSettings,
  },
}));

beforeEach(() => {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
  });
  setActivePinia(createPinia());
  bridgeMocks.getProviders.mockReset();
  bridgeMocks.getModels.mockReset();
  bridgeMocks.updateSettings.mockReset();
  bridgeMocks.updateSettings.mockImplementation(async (partial) => ({ ...useSettingsStore().settings, ...partial }));
});

describe('built-in model providers', () => {
  it('OpenCode Go 可进入内置模型选择流程', () => {
    expect(BUILTIN_PROVIDERS).toContain('opencode-go');
  });

  it('以 pi-ai 动态目录为准加载全部供应商及模型', async () => {
    bridgeMocks.getProviders.mockResolvedValue(['openai', 'new-pi-provider']);
    bridgeMocks.getModels.mockImplementation(async (provider: string) => [
      {
        id: `${provider}-model`,
        name: `${provider} model`,
        provider,
        contextWindow: 128000,
      },
    ]);
    const store = useModelsStore();

    await store.loadProviders();

    expect(store.builtinProviders).toEqual(['openai', 'new-pi-provider']);
    expect(store.providers).toEqual(['openai', 'new-pi-provider']);
    expect(bridgeMocks.getModels).toHaveBeenCalledTimes(2);
    expect(store.allModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'openai', model: 'openai-model' }),
        expect.objectContaining({
          provider: 'new-pi-provider',
          model: 'new-pi-provider-model',
        }),
      ]),
    );
  });
});

describe('generateEndpointId', () => {
  it('中文会被替换为分隔符，slug 为空时兜底 endpoint', () => {
    expect(generateEndpointId('我的内网网关', [], [])).toBe('custom-endpoint');
  });

  it('符号压缩为连字符并修剪首尾', () => {
    expect(generateEndpointId('---My  GW---', [], [])).toBe('custom-my-gw');
  });

  it('英文/数字正常 slugify', () => {
    expect(generateEndpointId('My Gateway 2', [], [])).toBe('custom-my-gateway-2');
  });

  it('与已有 id 冲突时追加 -2/-3', () => {
    expect(generateEndpointId('My Gateway', ['custom-my-gateway'], [])).toBe('custom-my-gateway-2');
    expect(
      generateEndpointId('My Gateway', ['custom-my-gateway', 'custom-my-gateway-2'], []),
    ).toBe('custom-my-gateway-3');
  });

  it('与已有自定义 id 冲突时避让', () => {
    expect(generateEndpointId('openai', ['custom-openai'], [])).toBe('custom-openai-2');
  });
});

describe('validateEndpoint', () => {
  const ok = {
    name: 'GW',
    baseUrl: 'https://gw/v1',
    apiKey: 'k',
    models: [{ id: 'm1' }],
  };

  it('合法表单返回空数组', () => {
    expect(validateEndpoint(ok)).toEqual([]);
  });

  it('缺显示名', () => {
    expect(validateEndpoint({ ...ok, name: ' ' })).toContain('显示名不能为空');
  });

  it('URL 非法', () => {
    expect(validateEndpoint({ ...ok, baseUrl: 'gw' })).toContain('URL 需以 http:// 或 https:// 开头');
    expect(validateEndpoint({ ...ok, baseUrl: '' })).toContain('URL 不能为空');
  });

  it('缺 Key', () => {
    expect(validateEndpoint({ ...ok, apiKey: '' })).toContain('API Key 不能为空');
  });

  it('无有效模型', () => {
    expect(validateEndpoint({ ...ok, models: [{ id: '' }] })).toContain('至少添加一个模型');
  });
});


describe('chat model visibility', () => {
  it('defaults legacy settings to the active model, not every model with a key', () => {
    const settings = useSettingsStore();
    settings.settings.activeProvider = 'deepseek';
    settings.settings.activeModel = 'deepseek-v4-pro';
    const store = useModelsStore();
    store.keyStatus = { deepseek: true, openai: true };
    expect(store.switchableModelOptions.map((m) => m.model)).toEqual(['deepseek-v4-pro']);
  });

  it('persists selections for builtin and custom models, allows none, and keeps the active model', async () => {
    const settings = useSettingsStore();
    settings.settings.chatModels = [];
    const store = useModelsStore();
    store.keyStatus = { deepseek: true, 'custom-gw': true };
    store.providerModels.set('custom-gw', [{ provider: 'custom-gw', model: 'm1', label: 'M1' }]);
    await store.setChatModel('deepseek', 'deepseek-v4-flash', true);
    await store.setChatModel('custom-gw', 'm1', true);
    expect(store.switchableModelOptions.map((m) => m.model)).toEqual(['deepseek-v4-flash', 'm1']);
    await store.setChatModel('deepseek', 'deepseek-v4-flash', false);
    await store.setChatModel('custom-gw', 'm1', false);
    expect(settings.settings.chatModels).toEqual([]);
    expect(store.switchableModelOptions).toEqual([]);
    expect(store.activeModel).toBe('deepseek-v4-pro');
    setActivePinia(createPinia());
    useSettingsStore().settings.chatModels = [];
    const reloaded = useModelsStore();
    reloaded.keyStatus = { deepseek: true };
    expect(reloaded.switchableModelOptions).toEqual([]);
  });

  it('does not display selected models without credentials or auto-select newly discovered models', async () => {
    useSettingsStore().settings.chatModels = [{ provider: 'openai', model: 'chosen' }];
    const store = useModelsStore();
    bridgeMocks.getModels.mockResolvedValue([
      { id: 'chosen', name: 'Chosen', provider: 'openai' },
      { id: 'new-model', name: 'New', provider: 'openai' },
    ]);
    await store.loadModels('openai', true);
    expect(store.switchableModelOptions).toEqual([]);
    store.keyStatus = { openai: true };
    expect(store.switchableModelOptions.map((m) => m.model)).toEqual(['chosen']);
    expect(bridgeMocks.getModels).toHaveBeenCalledWith('openai', true);
  });

  it('replaces a refreshed provider list and retains it on a failed refresh', async () => {
    const store = useModelsStore();
    bridgeMocks.getModels.mockResolvedValue([{ id: 'old', provider: 'openai' }]);
    await store.loadModels('openai');
    bridgeMocks.getModels.mockResolvedValue([{ id: 'new', provider: 'openai' }]);
    await store.loadModels('openai', true);
    expect(store.providerModels.get('openai')?.map((m) => m.model)).toEqual(['new']);
    bridgeMocks.getModels.mockRejectedValue(new Error('offline'));
    await store.loadModels('openai', true);
    expect(store.providerModels.get('openai')?.map((m) => m.model)).toEqual(['new']);
  });
});

describe('modelFamily series grouping', () => {
  it('groups aggregated opencode-go models by series prefix', () => {
    expect(modelFamily('opencode-go', 'deepseek-v4-pro')).toBe('DeepSeek');
    expect(modelFamily('opencode-go', 'deepseek-v4.1-flash')).toBe('DeepSeek');
    expect(modelFamily('opencode-go', 'qwen3.7-max')).toBe('Qwen');
    expect(modelFamily('opencode-go', 'kimi-k2.7-code')).toBe('Kimi');
    expect(modelFamily('opencode-go', 'glm-5.3')).toBe('GLM');
    expect(modelFamily('opencode-go', 'grok-4.6')).toBe('Grok');
    expect(modelFamily('opencode-go', 'minimax-m2.7')).toBe('MiniMax');
    expect(modelFamily('opencode-go', 'gpt-5.6-luna')).toBe('GPT');
    expect(modelFamily('opencode-go', 'omen-alpha')).toBe('Omen');
  });

  it('keeps native providers ungrouped', () => {
    expect(modelFamily('deepseek', 'deepseek-v4-pro')).toBe('');
    expect(modelFamily('anthropic', 'claude-sonnet-4-5')).toBe('');
    expect(modelFamily('openai', 'gpt-5.3-codex')).toBe('');
  });

  it('groups openrouter models by vendor prefix', () => {
    expect(modelFamily('openrouter', 'openai/gpt-5.1-codex')).toBe('openai');
    expect(modelFamily('openrouter', 'anthropic/claude-sonnet-4.5')).toBe('anthropic');
  });
});

describe('settings store IPC payload', () => {
  it('strips Vue reactivity from update() payloads so structured clone accepts them', async () => {
    // Reproduce the production path: entries read back from the reactive
    // store (e.g. models.ts setChatModel/selectModel) are reactive proxies,
    // which ipcRenderer.invoke cannot clone.
    useSettingsStore().settings.chatModels = [{ provider: 'anthropic', model: 'claude-sonnet-4-5' }];
    const proxied = useSettingsStore().settings.chatModels as Array<{
      provider: string;
      model: string;
    }>;
    const selected = proxied.filter(
      (entry) => entry.provider !== 'openai' || entry.model !== 'gpt',
    );

    await useSettingsStore().update({ chatModels: selected });

    const arg = bridgeMocks.updateSettings.mock.calls.at(-1)?.[0];
    expect(structuredClone(arg)).toEqual({
      chatModels: [{ provider: 'anthropic', model: 'claude-sonnet-4-5' }],
      permissionMode: 'full_access',
    });
  });
});
