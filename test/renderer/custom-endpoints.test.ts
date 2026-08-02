import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateEndpointId, validateEndpoint } from '../../src/renderer/components/settings/custom-endpoints';
import { BUILTIN_PROVIDERS, useModelsStore } from '../../src/renderer/stores/models';

const bridgeMocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getModels: vi.fn(),
}));

vi.mock('../../src/renderer/api/bridge', () => ({
  bridge: {
    getProviders: bridgeMocks.getProviders,
    getModels: bridgeMocks.getModels,
  },
}));

beforeEach(() => {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
  });
  setActivePinia(createPinia());
  bridgeMocks.getProviders.mockReset();
  bridgeMocks.getModels.mockReset();
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
