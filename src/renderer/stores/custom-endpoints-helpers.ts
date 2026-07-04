import type { CustomEndpoint } from '@shared/types';
import type { ModelOption } from './models';

/** 为单个自定义 endpoint 下每个模型生成 ModelOption。 */
export function buildCustomModelOptions(endpoint: CustomEndpoint): ModelOption[] {
  return endpoint.models.map((m) => {
    const ctx = m.contextWindow || 128000;
    return {
      provider: endpoint.id,
      model: m.id,
      label: `${m.name || m.id} (${(ctx / 1000).toFixed(0)}k)`,
    };
  });
}

export interface CustomEndpointState {
  providerIds: string[];
  providerModels: Map<string, ModelOption[]>;
  keyStatus: Record<string, boolean>;
}

/** 聚合多个自定义 endpoint 为 store 注入所需的状态。 */
export function computeCustomEndpointState(endpoints: CustomEndpoint[]): CustomEndpointState {
  const providerModels = new Map<string, ModelOption[]>();
  const keyStatus: Record<string, boolean> = {};
  for (const ep of endpoints) {
    providerModels.set(ep.id, buildCustomModelOptions(ep));
    keyStatus[ep.id] = Boolean(ep.apiKey.trim());
  }
  return {
    providerIds: endpoints.map((e) => e.id),
    providerModels,
    keyStatus,
  };
}

export function computeProviderKeyStatus(input: {
  providers: string[];
  envApiKeys: Record<string, string>;
  customEndpoints: CustomEndpoint[];
}): Record<string, boolean> {
  const status: Record<string, boolean> = {};
  for (const provider of input.providers) {
    status[provider] = Boolean(input.envApiKeys[provider]);
  }
  for (const endpoint of input.customEndpoints) {
    status[endpoint.id] = Boolean(endpoint.apiKey.trim());
  }
  return status;
}

export function mergeProvidersWithCustom(
  providers: string[],
  customProviderIds: string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const provider of [...providers, ...customProviderIds]) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    result.push(provider);
  }
  return result;
}
