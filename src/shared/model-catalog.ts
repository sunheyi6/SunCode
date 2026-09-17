import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import { getEnvApiKey, getModels, getProviders } from '@earendil-works/pi-ai/compat';

type CatalogModel = Model<Api>;
interface RemoteModel {
  id: string;
  name?: string;
  family?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  provider?: { npm?: string; api?: string };
}
interface RemoteProvider {
  npm?: string;
  models: Record<string, RemoteModel>;
}
type RemoteCatalog = Record<string, RemoteProvider>;

const TTL = 60 * 60 * 1000;
const RETRY_DELAY = 30_000;
const PACKAGE_APIS: Record<string, Api> = {
  '@ai-sdk/openai-compatible': 'openai-completions',
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/google': 'google-generative-ai',
  '@ai-sdk/mistral': 'mistral-conversations',
};

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  supportsReasoning: boolean;
  supportsImages: boolean;
}

export function modelInfo(model: CatalogModel): ModelInfo {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsReasoning: model.reasoning,
    supportsImages: model.input.includes('image'),
  };
}

/** Use pi-ai's transport configuration; remote metadata must not redirect requests or credentials. */
export function mergeCatalogModels(
  builtin: CatalogModel[],
  remote: RemoteProvider | undefined,
): CatalogModel[] {
  const result = new Map(builtin.map((model) => [model.id, model]));
  if (!remote?.models) return builtin;
  for (const entry of Object.values(remote.models)) {
    if (!entry || typeof entry.id !== 'string' || entry.tool_call === false) continue;
    if (entry.modalities?.input && !Array.isArray(entry.modalities.input)) continue;
    if (
      [entry.limit?.context, entry.limit?.output].some(
        (value) => value !== undefined && (!Number.isFinite(value) || value <= 0),
      )
    )
      continue;
    const existing = result.get(entry.id);
    const api = PACKAGE_APIS[entry.provider?.npm ?? remote.npm ?? ''];
    const explicitApi = PACKAGE_APIS[entry.provider?.npm ?? ''];
    const candidates = builtin.filter((model) => !explicitApi || model.api === explicitApi);
    const familyModel = candidates.find(
      (model) => entry.family && remote.models[model.id]?.family === entry.family,
    );
    // Mixed-protocol providers require a known transport; never guess from the model ID.
    const uniformTransport =
      new Set(builtin.map((model) => `${model.api}:${model.baseUrl}`)).size === 1;
    const template =
      existing ??
      familyModel ??
      candidates.find((model) => model.api === api) ??
      (!entry.provider?.npm && uniformTransport ? builtin[0] : undefined);
    if (!template || (!existing && (!entry.limit?.context || !entry.limit.output))) continue;
    if (entry.provider?.api) {
      try {
        if (new URL(entry.provider.api).origin !== new URL(template.baseUrl).origin) continue;
      } catch {
        continue;
      }
    }
    const model: CatalogModel = {
      ...template,
      id: entry.id,
      name: entry.name || entry.id,
      reasoning: entry.reasoning ?? existing?.reasoning ?? false,
      input: entry.modalities?.input
        ? entry.modalities.input.includes('image')
          ? ['text', 'image']
          : ['text']
        : (existing?.input ?? ['text']),
      contextWindow: entry.limit?.context ?? template.contextWindow,
      maxTokens: entry.limit?.output ?? template.maxTokens,
      cost: existing?.cost ?? {
        input: entry.cost?.input ?? 0,
        output: entry.cost?.output ?? 0,
        cacheRead: entry.cost?.cache_read ?? 0,
        cacheWrite: entry.cost?.cache_write ?? 0,
      },
      // Family-specific thinking settings must not leak into unrelated models.
      compat: existing?.compat ?? familyModel?.compat,
      thinkingLevelMap: existing?.thinkingLevelMap ?? familyModel?.thinkingLevelMap,
      samplingParams: existing?.samplingParams ?? familyModel?.samplingParams,
    };
    result.set(model.id, model);
  }
  return [...result.values()];
}

/** One directory implementation for Main, Worker and headless callers. */
export function createModelCatalog(fetcher: typeof fetch = fetch, cacheFile?: () => string) {
  let remote: RemoteCatalog = {};
  let expiresAt = 0;
  let pending: Promise<void> | undefined;
  let diskMtime = 0;
  const official = new Map<
    string,
    { ids: Set<string> | undefined; expiresAt: number; key: string | undefined }
  >();
  const officialPending = new Map<string, Promise<Set<string> | undefined>>();

  async function officialIds(provider: string, builtin: CatalogModel[], force: boolean) {
    const inflight = officialPending.get(provider);
    if (inflight) return inflight;
    const cached = official.get(provider);
    const publicProvider = provider === 'opencode' || provider === 'opencode-go';
    const apiKey = getEnvApiKey(provider);
    if (!force && cached && cached.key === apiKey && Date.now() < cached.expiresAt)
      return cached.ids;
    if (!publicProvider && !apiKey) return undefined;
    const urls = [...new Set(builtin.map((model) => model.baseUrl))];
    const nativeProvider =
      provider === 'anthropic' || provider === 'google' || provider === 'mistral';
    const baseUrl = publicProvider
      ? `https://opencode.ai/zen${provider === 'opencode-go' ? '/go' : ''}/v1`
      : urls.length === 1 &&
          (nativeProvider ||
            builtin.every(
              (model) => model.api === 'openai-completions' || model.api === 'openai-responses',
            ))
        ? urls[0]
        : undefined;
    if (!baseUrl?.startsWith('https://')) return undefined;
    const request = (async () => {
      try {
        const headers: Record<string, string> = {};
        if (apiKey) {
          if (provider === 'google') headers['x-goog-api-key'] = apiKey;
          else if (provider === 'anthropic') {
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
          } else headers.Authorization = `Bearer ${apiKey}`;
        }
        const prefix = provider === 'anthropic' || provider === 'mistral' ? '/v1' : '';
        const url = new URL(`${baseUrl.replace(/\/$/, '')}${prefix}/models`);
        const ids = new Set<string>();
        const signal = AbortSignal.timeout(8000);
        for (let page = 0; page < 50; page++) {
          const response = await fetcher(url.toString(), { headers, signal, redirect: 'error' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = (await response.json()) as {
            data?: Array<{ id?: unknown }>;
            models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
            nextPageToken?: string;
            has_more?: boolean;
            last_id?: string;
          };
          if (provider === 'google') {
            if (!Array.isArray(body.models)) throw new Error('Invalid provider catalog');
            for (const model of body.models) {
              if (model.name && model.supportedGenerationMethods?.includes('generateContent')) {
                ids.add(model.name.replace(/^models\//, ''));
              }
            }
          } else {
            if (!Array.isArray(body.data)) throw new Error('Invalid provider catalog');
            for (const model of body.data) if (typeof model?.id === 'string') ids.add(model.id);
          }
          if (body.nextPageToken) url.searchParams.set('pageToken', body.nextPageToken);
          else if (body.has_more && body.last_id) url.searchParams.set('after_id', body.last_id);
          else break;
          if (page === 49) throw new Error('Incomplete provider catalog');
        }
        official.set(provider, { ids, expiresAt: Date.now() + TTL, key: apiKey });
        return ids;
      } catch {
        const ids = cached && cached.key === apiKey ? cached.ids : undefined;
        official.set(provider, { ids, expiresAt: Date.now() + RETRY_DELAY, key: apiKey });
        return ids;
      }
    })().finally(() => officialPending.delete(provider));
    officialPending.set(provider, request);
    return request;
  }

  async function refresh(force = false): Promise<void> {
    if (pending) return pending;
    pending = (async () => {
      // Main and Worker observe the same persisted metadata after a manual refresh.
      const path = cacheFile?.();
      if (path) {
        try {
          const info = await stat(path);
          if (info.mtimeMs !== diskMtime) {
            const saved = JSON.parse(await readFile(path, 'utf8')) as {
              data: RemoteCatalog;
              checkedAt: number;
            };
            if (saved.data && typeof saved.data === 'object' && Number.isFinite(saved.checkedAt)) {
              remote = saved.data;
              expiresAt = saved.checkedAt + TTL;
              diskMtime = info.mtimeMs;
            }
          }
        } catch {
          /* A missing or invalid cache falls back to the bundled directory. */
        }
      }
      if (!force && Date.now() < expiresAt) return;
      try {
        const response = await fetcher('https://models.dev/api.json', {
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: unknown = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('Invalid model catalog');
        }
        remote = data as RemoteCatalog;
        expiresAt = Date.now() + TTL;
        if (path) {
          try {
            await mkdir(dirname(path), { recursive: true });
            const temporary = `${path}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify({ data: remote, checkedAt: Date.now() }));
            await rename(temporary, path);
            diskMtime = (await stat(path)).mtimeMs;
          } catch {
            /* Directory refresh still works when cache storage is unavailable. */
          }
        }
      } catch {
        // Retain the last successful directory, or fall back to pi-ai when offline.
        expiresAt = Date.now() + RETRY_DELAY;
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  async function models(provider: string, force = false): Promise<CatalogModel[]> {
    const builtin = getModels(provider as Parameters<typeof getModels>[0]) as CatalogModel[];
    const [, ids] = await Promise.all([refresh(force), officialIds(provider, builtin, force)]);
    const merged = mergeCatalogModels(builtin, remote[provider]);
    return ids ? merged.filter((model) => ids.has(model.id)) : merged;
  }

  return {
    getProviders: async () => getProviders(),
    getModels: models,
    async getModel(provider: string, id: string): Promise<CatalogModel | undefined> {
      const found = (await models(provider)).find((model) => model.id === id);
      if (found) return found;
      // A different process may have refreshed the menu since our provider cache was populated.
      return (await models(provider, true)).find((model) => model.id === id);
    },
  };
}

export const modelCatalog = createModelCatalog(fetch, () =>
  join(process.env.SUNCODE_APP_DATA || join(homedir(), '.suncode'), 'model-catalog.json'),
);
