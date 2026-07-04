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
    keyStatus[ep.id] = true;
  }
  return {
    providerIds: endpoints.map((e) => e.id),
    providerModels,
    keyStatus,
  };
}
