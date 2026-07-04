import { describe, expect, it } from 'vitest';
import type { CustomEndpoint } from '@shared/types';
import {
  buildCustomModelOptions,
  computeProviderKeyStatus,
  computeCustomEndpointState,
  mergeProvidersWithCustom,
} from '../../src/renderer/stores/custom-endpoints-helpers';

function ep(over: Partial<CustomEndpoint>): CustomEndpoint {
  return {
    id: 'custom-gw',
    name: '网关',
    baseUrl: 'https://gw/v1',
    apiKey: 'k',
    apiFormat: 'openai-completions',
    models: [{ id: 'm1' }, { id: 'm2', name: 'M2', contextWindow: 64000 }],
    ...over,
  };
}

describe('buildCustomModelOptions', () => {
  it('为 endpoint 下每个模型生成 ModelOption', () => {
    const opts = buildCustomModelOptions(ep({}));
    expect(opts).toEqual([
      { provider: 'custom-gw', model: 'm1', label: 'm1 (128k)' },
      { provider: 'custom-gw', model: 'm2', label: 'M2 (64k)' },
    ]);
  });

  it('空模型列表返回空数组', () => {
    expect(buildCustomModelOptions(ep({ models: [] }))).toEqual([]);
  });
});

describe('computeCustomEndpointState', () => {
  it('聚合多个 endpoint 的 providers / providerModels / keyStatus', () => {
    const state = computeCustomEndpointState([
      ep({ id: 'custom-a', models: [{ id: 'x' }] }),
      ep({ id: 'custom-b', models: [{ id: 'y' }, { id: 'z' }] }),
    ]);
    expect(state.providerIds).toEqual(['custom-a', 'custom-b']);
    expect(state.providerModels.get('custom-a')).toEqual([
      { provider: 'custom-a', model: 'x', label: 'x (128k)' },
    ]);
    expect(state.providerModels.get('custom-b')).toHaveLength(2);
    expect(state.keyStatus).toEqual({ 'custom-a': true, 'custom-b': true });
  });
});

describe('computeProviderKeyStatus', () => {
  it('合并内置 env key 与自定义 endpoint key', () => {
    expect(
      computeProviderKeyStatus({
        providers: ['openai', 'custom-a'],
        envApiKeys: { openai: 'sk-openai' },
        customEndpoints: [ep({ id: 'custom-a', apiKey: 'sk-custom' })],
      }),
    ).toEqual({ openai: true, 'custom-a': true });
  });

  it('自定义 endpoint 没有 key 时标记为未配置', () => {
    expect(
      computeProviderKeyStatus({
        providers: ['custom-a'],
        envApiKeys: {},
        customEndpoints: [ep({ id: 'custom-a', apiKey: ' ' })],
      }),
    ).toEqual({ 'custom-a': false });
  });
});

describe('mergeProvidersWithCustom', () => {
  it('加载内置 provider 时保留自定义 provider', () => {
    expect(mergeProvidersWithCustom(['openai', 'deepseek'], ['custom-ollama'])).toEqual([
      'openai',
      'deepseek',
      'custom-ollama',
    ]);
  });

  it('去重并保留内置 provider 顺序', () => {
    expect(mergeProvidersWithCustom(['custom-ollama', 'openai'], ['custom-ollama'])).toEqual([
      'custom-ollama',
      'openai',
    ]);
  });
});
