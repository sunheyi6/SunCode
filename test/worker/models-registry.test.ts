import { describe, expect, it } from 'vitest';
import type { CustomEndpoint } from '@shared/types';
import { buildCustomModel, createModelRegistry } from '../../src/worker/models/registry';

function endpoint(over: Partial<CustomEndpoint>): CustomEndpoint {
  return {
    id: 'custom-gw',
    name: '网关',
    baseUrl: 'https://gw.example.com/v1',
    apiKey: 'sk-test',
    apiFormat: 'openai-completions',
    models: [{ id: 'm1' }, { id: 'm2', name: 'M2', contextWindow: 64000 }],
    ...over,
  };
}

describe('buildCustomModel', () => {
  it('用默认值填充 name / contextWindow', () => {
    const m = buildCustomModel(endpoint({}), { id: 'm1' });
    expect(m.id).toBe('m1');
    expect(m.name).toBe('m1');
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBe(4096);
    expect(m.reasoning).toBe(false);
    expect(m.input).toEqual(['text']);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('openai-completions 使用 Bearer 鉴权', () => {
    const m = buildCustomModel(endpoint({}), { id: 'm1' });
    expect(m.api).toBe('openai-completions');
    expect(m.headers).toEqual({ Authorization: 'Bearer sk-test' });
  });

  it('openai-responses 使用 Bearer 鉴权', () => {
    const m = buildCustomModel(endpoint({ apiFormat: 'openai-responses' }), { id: 'm1' });
    expect(m.api).toBe('openai-responses');
    expect(m.headers.Authorization).toBe('Bearer sk-test');
  });

  it('anthropic-messages 使用 x-api-key + version', () => {
    const m = buildCustomModel(endpoint({ apiFormat: 'anthropic-messages' }), { id: 'm1' });
    expect(m.api).toBe('anthropic-messages');
    expect(m.headers).toEqual({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' });
  });

  it('沿用 entry 的 name / contextWindow', () => {
    const m = buildCustomModel(endpoint({}), { id: 'm2', name: 'M2', contextWindow: 64000 });
    expect(m.name).toBe('M2');
    expect(m.contextWindow).toBe(64000);
    expect(m.provider).toBe('custom-gw');
    expect(m.baseUrl).toBe('https://gw.example.com/v1');
  });
});

describe('createModelRegistry.getModel 自定义短路', () => {
  it('命中自定义 endpoint + 模型时返回构造对象', async () => {
    const reg = createModelRegistry([endpoint({})]);
    const m = await reg.getModel('custom-gw', 'm1');
    expect(m).not.toBeNull();
    expect((m as { id: string }).id).toBe('m1');
  });

  it('endpoint 存在但模型未列出时返回 null', async () => {
    const reg = createModelRegistry([endpoint({})]);
    const m = await reg.getModel('custom-gw', 'no-such-model');
    expect(m).toBeNull();
  });
});