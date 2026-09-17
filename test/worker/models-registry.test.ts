import { createServer, type IncomingHttpHeaders } from 'node:http';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import type { Api, Model } from '@earendil-works/pi-ai';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { getModels } from '@earendil-works/pi-ai/compat';
import { createModelCatalog, mergeCatalogModels, modelCatalog } from '../../src/shared/model-catalog';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => vi.restoreAllMocks());
import { getProviderHeaders } from '../../src/shared/provider-headers';
import type { CustomEndpoint } from '@shared/types';
import { buildCustomModel, createModelRegistry } from '../../src/worker/models/registry';
import {
  modelDeclaresImageInput,
  resolveModelImageSupport,
  resolveVisionTarget,
  withImageInput,
} from '../../src/worker/models/vision-routing';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';

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

describe('OpenCode request headers', () => {
  it('recognizes built-in providers and custom OpenCode endpoints without matching other hosts', () => {
    for (const model of [
      { provider: 'opencode' },
      { provider: 'opencode-go' },
      { provider: 'custom-go', baseUrl: 'https://opencode.ai/zen/go/v1' },
    ]) {
      expect(getProviderHeaders(model, 'conversation-a')).toMatchObject({
        'x-opencode-session': 'conversation-a',
        'User-Agent': expect.stringMatching(/^SunCode\//),
      });
      expect(getProviderHeaders(model, 'conversation-b')?.['x-opencode-session']).toBe(
        'conversation-b',
      );
    }
    for (const model of [
      null,
      {},
      { provider: 'openai' },
      { baseUrl: 'https://opencode.ai.example.com/v1' },
      { baseUrl: 'https://example.com/opencode.ai' },
      { baseUrl: 'invalid-url' },
    ]) {
      expect(getProviderHeaders(model, 'conversation-a')).toBeUndefined();
    }
  });

  it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)(
    'sends routing headers over HTTP through %s even with caching disabled',
    async (api) => {
      const received: IncomingHttpHeaders[] = [];
      const server = createServer((request, response) => {
        received.push(request.headers);
        request.resume();
        // A terminal response lets us inspect the real SDK request without a provider account.
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          error: { message: 'test response', type: 'invalid_request_error' },
        }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing test server port');
        const model = {
          ...buildCustomModel(endpoint({ apiFormat: api }), { id: 'test-model' }),
          provider: 'opencode-go',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
        } as Model<Api>;
        for (const sessionId of ['conversation-a', 'conversation-a', 'conversation-b']) {
          await completeSimple(
            model,
            { messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] },
            {
              apiKey: 'test-key',
              cacheRetention: 'none',
              headers: getProviderHeaders(model, sessionId),
            },
          );
        }
        expect(received.map((headers) => headers['x-opencode-session'])).toEqual([
          'conversation-a', 'conversation-a', 'conversation-b',
        ]);
        for (const headers of received) {
          expect(headers['user-agent']).toMatch(/^SunCode\//);
          expect(headers[api === 'anthropic-messages' ? 'x-api-key' : 'authorization']).toBe(
            api === 'anthropic-messages' ? 'sk-test' : 'Bearer sk-test',
          );
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    },
  );
});

describe('buildCustomModel', () => {
  it('用默认值填充 name / contextWindow', () => {
    const m = buildCustomModel(endpoint({}), { id: 'm1' });
    expect(m.id).toBe('m1');
    expect(m.name).toBe('m1');
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBe(4096);
    expect(m.reasoning).toBe(false);
    expect(m.input).toEqual(['text']);
    expect(m.apiKey).toBe('sk-test');
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

  it('可声明自定义模型接受图片输入', () => {
    const m = buildCustomModel(endpoint({}), { id: 'vision', supportsImages: true });
    expect(m.input).toEqual(['text', 'image']);
  });
});

describe('vision routing', () => {
  it('优先使用模型目录自动识别图片能力', () => {
    const settings = { ...DEFAULT_SETTINGS, visionRouting: { enabled: true, providers: {} } };
    const model = { input: ['text', 'image'] };
    expect(modelDeclaresImageInput(model)).toBe(true);
    expect(resolveModelImageSupport(settings, 'opencode-go', 'kimi', model)).toBe(true);
  });

  it('手动覆盖优先于模型目录', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      activeProvider: 'opencode-go',
      activeModel: 'deepseek-v4-pro',
      visionRouting: {
        enabled: true,
        providers: {
          'opencode-go': {
            model: 'qwen-vision',
            capabilityOverrides: { 'qwen-vision': true, 'catalog-vision': false },
          },
        },
      },
    };
    expect(
      resolveModelImageSupport(settings, 'opencode-go', 'catalog-vision', {
        input: ['text', 'image'],
      }),
    ).toBe(false);
    expect(resolveVisionTarget(settings, { input: ['text'] })).toEqual({
      provider: 'opencode-go',
      model: 'qwen-vision',
      forcedImageSupport: true,
    });
    expect(modelDeclaresImageInput(withImageInput({ input: ['text'] }))).toBe(true);
  });

  it('功能关闭时不产生视觉目标', () => {
    expect(resolveVisionTarget({ ...DEFAULT_SETTINGS }, { input: ['text', 'image'] })).toBeNull();
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

describe('createModelRegistry OpenCode Go', () => {
  it('可发现并加载 OpenCode Go 模型', async () => {
    vi.spyOn(modelCatalog, 'getModels').mockResolvedValue(getModels('opencode-go'));
    vi.spyOn(modelCatalog, 'getModel').mockImplementation(async (_provider, id) => getModels('opencode-go').find((m) => m.id === id));
    const reg = createModelRegistry();
    const models = await reg.getModels('opencode-go');

    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.provider === 'opencode-go')).toBe(true);
    expect(await reg.getModel('opencode-go', models[0].id)).not.toBeNull();
  });
});


const remoteGo = {
  npm: '@ai-sdk/openai-compatible',
  models: {
    'deepseek-v4-flash': { id: 'deepseek-v4-flash', family: 'deepseek-flash' },
    'deepseek-v4.1-flash': {
      id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', family: 'deepseek-flash',
      tool_call: true, reasoning: true, modalities: { input: ['text', 'image'] },
      limit: { context: 1000000, output: 384000 },
    },
  },
};

function directoryFetch() {
  return vi.fn(async (url: string | URL | Request) => Response.json(
    String(url).includes('models.dev') ? { 'opencode-go': remoteGo } : {
      data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4.1-flash' }],
    },
  ));
}

describe('shared online model catalog', () => {
  it('resolves newly discovered models with family reasoning compatibility and image capabilities', async () => {
    const fetcher = directoryFetch();
    const catalog = createModelCatalog(fetcher as typeof fetch);
    const list = await catalog.getModels('opencode-go');
    const model = await catalog.getModel('opencode-go', 'deepseek-v4.1-flash');
    expect(list).toContainEqual(model);
    expect(model).toMatchObject({
      id: 'deepseek-v4.1-flash', provider: 'opencode-go', api: 'openai-completions',
      baseUrl: 'https://opencode.ai/zen/go/v1', input: ['text', 'image'],
      contextWindow: 1000000, maxTokens: 384000,
      compat: { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent directory requests and refreshes on demand', async () => {
    const fetcher = directoryFetch();
    const catalog = createModelCatalog(fetcher as typeof fetch);
    await Promise.all([catalog.getModels('opencode-go'), catalog.getModels('opencode-go')]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await catalog.getModels('opencode-go', true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('falls back offline and retains a successful directory after refresh failure', async () => {
    const fetcher = directoryFetch();
    const catalog = createModelCatalog(fetcher as typeof fetch);
    await catalog.getModels('opencode-go');
    fetcher.mockRejectedValue(new Error('offline'));
    expect(await catalog.getModels('opencode-go', true)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'deepseek-v4.1-flash' })]),
    );
    const offline = createModelCatalog(fetcher as typeof fetch);
    expect(await offline.getModels('opencode-go')).toEqual(getModels('opencode-go'));
    const calls = fetcher.mock.calls.length;
    await offline.getModels('opencode-go');
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });

  it('shares persisted metadata with another process and survives an offline restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suncode-catalog-'));
    try {
      const cacheFile = () => join(dir, 'models.json');
      await createModelCatalog(directoryFetch() as typeof fetch, cacheFile).getModels('opencode-go');
      const offline = vi.fn().mockRejectedValue(new Error('offline'));
      const restarted = createModelCatalog(offline as typeof fetch, cacheFile);
      expect(await restarted.getModel('opencode-go', 'deepseek-v4.1-flash')).toMatchObject({
        id: 'deepseek-v4.1-flash', input: ['text', 'image'],
      });
      expect(offline.mock.calls.every(([url]) => !String(url).includes('models.dev'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports other providers and preserves mixed protocols without leaking family-specific settings', () => {
    const builtin = getModels('opencode-go');
    const minimax = builtin.find((m) => m.id === 'minimax-m3')!;
    const merged = mergeCatalogModels(builtin, {
      npm: '@ai-sdk/openai-compatible', models: {
        ...remoteGo.models,
        'minimax-new': { id: 'minimax-new', provider: { npm: '@ai-sdk/anthropic' },
          limit: { context: 1000000, output: 8192 } },
        'unknown': { id: 'unknown', limit: { context: 128000, output: 8192 } },
        'unsafe': { id: 'unsafe', provider: { api: 'https://different.example/v1' },
          limit: { context: 128000, output: 8192 } },
      },
    });
    expect(merged.find((m) => m.id === 'minimax-new')).toMatchObject({
      api: 'anthropic-messages', baseUrl: minimax.baseUrl,
    });
    expect(merged.find((m) => m.id === 'unknown')?.compat).toBeUndefined();
    expect(merged.find((m) => m.id === 'unsafe')).toBeUndefined();
    const openai = mergeCatalogModels(getModels('openai'), {
      npm: '@ai-sdk/openai', models: { future: {
        id: 'future', limit: { context: 128000, output: 8192 },
      } },
    });
    expect(openai.find((m) => m.id === 'future')).toMatchObject({
      provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
    });
  });
});
