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

import type { AppSettings } from '@shared/types';

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  supportsReasoning: boolean;
  supportsImages: boolean;
}

/**
 * Create a model registry that wraps pi-ai.
 */
export function createModelRegistry() {
  let modelsCache: ModelInfo[] | null = null;
  let providersCache: string[] | null = null;

  return {
    /**
     * Get a specific model by provider and model ID.
     */
    async getModel(provider: string, modelId: string): Promise<unknown> {
      try {
        const { getModel } = await import('@earendil-works/pi-ai');
        return getModel(provider, modelId);
      } catch {
        console.warn(
          '@earendil-works/pi-ai not available. Install it for multi-provider model support.',
        );
        return null;
      }
    },

    /**
     * Get all available providers.
     */
    async getProviders(): Promise<string[]> {
      if (providersCache) return providersCache;

      try {
        const { getProviders } = await import('@earendil-works/pi-ai');
        providersCache = getProviders();
        return providersCache;
      } catch {
        // Fallback: return commonly available providers
        providersCache = [
          'anthropic',
          'openai',
          'google',
          'deepseek',
          'xai',
          'groq',
          'mistral',
          'openrouter',
        ];
        return providersCache;
      }
    },

    /**
     * Get all models for a given provider.
     */
    async getModels(provider: string): Promise<ModelInfo[]> {
      try {
        const { getModels } = await import('@earendil-works/pi-ai');
        const models = getModels(provider);
        return models.map((m: Record<string, unknown>) => ({
          id: m.id as string,
          name: m.name as string,
          provider: (m.provider as string) || provider,
          contextWindow: (m.contextWindow as number) || 128000,
          maxTokens: (m.maxTokens as number) || 4096,
          supportsReasoning: Boolean(m.reasoning),
          supportsImages: Array.isArray(m.input) && (m.input as string[]).includes('image'),
        }));
      } catch {
        console.warn(`Failed to get models for provider: ${provider}`);
        return [];
      }
    },

    /**
     * Get recommended models for coding tasks.
     * Returns a curated list of models known to work well for software engineering.
     */
    getRecommendedModels(): Array<{ provider: string; model: string; label: string }> {
      return [
        { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
        { provider: 'anthropic', model: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
        { provider: 'openai', model: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
        { provider: 'openai', model: 'gpt-5-codex', label: 'GPT-5 Codex' },
        { provider: 'google', model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
        { provider: 'deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
        { provider: 'xai', model: 'grok-code-fast-1', label: 'Grok Code Fast' },
        { provider: 'openrouter', model: 'openai/gpt-5.1-codex', label: 'GPT-5.1 Codex (OpenRouter)' },
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
