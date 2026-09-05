import { RECOMMENDED_MODELS } from '@shared/constants';
import { ipcMain } from 'electron';

/** Register model discovery handlers with process local caches. */
export function registerModelIpcHandlers(): void {
  let providersCache: string[] | null = null;
  const modelsCache = new Map<string, unknown[]>();

  ipcMain.handle('models:getProviders', async () => {
    if (providersCache) return providersCache;
    try {
      const { getProviders } = await import('@earendil-works/pi-ai');
      providersCache = getProviders();
    } catch {
      providersCache = [
        'anthropic',
        'openai',
        'google',
        'deepseek',
        'xai',
        'groq',
        'mistral',
        'openrouter',
        'opencode-go',
      ];
    }
    return providersCache;
  });

  ipcMain.handle('models:getModels', async (_event, provider: string) => {
    const cached = modelsCache.get(provider);
    if (cached) return cached;

    try {
      const { getModels } = await import('@earendil-works/pi-ai');
      // pi-ai uses a literal union for providers; settings are validated at runtime.
      const models = getModels(provider as Parameters<typeof getModels>[0]);
      const result = models.map((model) => {
        const details = model as unknown as Record<string, unknown>;
        return {
          id: details.id as string,
          name: details.name as string,
          provider: (details.provider as string) || provider,
          contextWindow: (details.contextWindow as number) || 128000,
          maxTokens: (details.maxTokens as number) || 4096,
          supportsReasoning: Boolean(details.reasoning),
          supportsImages:
            Array.isArray(details.input) && (details.input as string[]).includes('image'),
        };
      });
      modelsCache.set(provider, result);
      return result;
    } catch {
      return [];
    }
  });

  ipcMain.handle('models:getRecommended', async () => RECOMMENDED_MODELS);
}
