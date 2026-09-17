import { type ModelInfo, modelCatalog, modelInfo } from '@shared/model-catalog';

export type { ModelInfo } from '@shared/model-catalog';

import { normalizeCustomEndpointBaseUrl } from '@shared/custom-endpoints';
import type { CustomEndpoint, CustomModelEntry } from '@shared/types';

/**
 * Model Registry - Wraps @earendil-works/pi-ai for model discovery and selection.
 * Provides a simpler API on top of pi-ai's comprehensive model database.
 *
 * pi-ai supports 30+ providers and 930+ models including:
 * - anthropic: Claude 3/3.5/4 (Haiku, Sonnet, Opus)
 * - openai: GPT-4/4o/5/o1/o3/o4 series
 * - google: Gemini 2.0/2.5/3.0/3.1/3.5 series
 * - deepseek: DeepSeek V4 Flash/Pro
 * - xai: Grok-3/4 series
 * - groq, mistral, together, fireworks, cerebras, openrouter, and many more
 */

/** 由自定义 endpoint + 模型条目构造的 pi-ai Model 兼容对象。 */
export interface CustomModelSpec {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers: Record<string, string>;
  apiKey: string;
}

/** 纯函数：根据 endpoint 与模型条目构造 Model 兼容对象（含鉴权 header）。 */
export function buildCustomModel(
  endpoint: CustomEndpoint,
  entry: CustomModelEntry,
): CustomModelSpec {
  const headers: Record<string, string> =
    endpoint.apiFormat === 'anthropic-messages'
      ? { 'x-api-key': endpoint.apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${endpoint.apiKey}` };
  return {
    id: entry.id,
    name: entry.name || entry.id,
    api: endpoint.apiFormat,
    provider: endpoint.id,
    baseUrl: normalizeCustomEndpointBaseUrl(endpoint.baseUrl, endpoint.apiFormat),
    reasoning: false,
    input: entry.supportsImages ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow || 128000,
    maxTokens: 4096,
    headers,
    apiKey: endpoint.apiKey,
  };
}

/**
 * Create a model registry that wraps pi-ai.
 */
export function createModelRegistry(customEndpoints: CustomEndpoint[] = []) {
  return {
    /**
     * Get a specific model by provider and model ID.
     */
    async getModel(provider: string, modelId: string): Promise<unknown> {
      const ep = customEndpoints.find((e) => e.id === provider);
      if (ep) {
        const entry = ep.models.find((m) => m.id === modelId);
        return entry ? buildCustomModel(ep, entry) : null;
      }
      return modelCatalog.getModel(provider, modelId);
    },

    getProviders(): Promise<string[]> {
      return modelCatalog.getProviders();
    },

    async getModels(provider: string): Promise<ModelInfo[]> {
      return (await modelCatalog.getModels(provider)).map(modelInfo);
    },

    /**
     * Get recommended models for coding tasks.
     * Returns a curated list of models known to work well for software engineering.
     */
    getRecommendedModels(): Array<{ provider: string; model: string; label: string }> {
      return [
        { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
        { provider: 'anthropic', model: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
        { provider: 'openai', model: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
        { provider: 'openai', model: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
        { provider: 'google', model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
        { provider: 'deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
        { provider: 'xai', model: 'grok-4.5', label: 'Grok 4.5' },
        {
          provider: 'openrouter',
          model: 'openai/gpt-5.1-codex',
          label: 'GPT-5.1 Codex (OpenRouter)',
        },
      ];
    },

    /**
     * Load all models into cache for offline access.
     */
    async preloadModels(): Promise<void> {
      const providers = await this.getProviders();
      for (const provider of providers) {
        try {
          await this.getModels(provider);
        } catch {
          // Skip providers that fail to load
        }
      }
    },
  };
}
