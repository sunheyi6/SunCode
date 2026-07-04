import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { AppSettings, CustomApiFormat, CustomEndpoint, CustomModelEntry } from '@shared/types';

describe('customEndpoints data model', () => {
  it('DEFAULT_SETTINGS.customEndpoints 初始化为空数组', () => {
    expect(DEFAULT_SETTINGS.customEndpoints).toEqual([]);
  });

  it('DEFAULT_SETTINGS 满足 AppSettings 形状', () => {
    const s: AppSettings = { ...DEFAULT_SETTINGS } as AppSettings;
    expect(Array.isArray(s.customEndpoints)).toBe(true);
  });

  it('CustomEndpoint / CustomModelEntry 字段齐备', () => {
    const m: CustomModelEntry = { id: 'gpt-x', name: 'GPT X', contextWindow: 64000 };
    const e: CustomEndpoint = {
      id: 'custom-my-gw',
      name: '我的网关',
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sk-xxx',
      apiFormat: 'openai-completions',
      models: [m, { id: 'qwen-x' }],
    };
    expect(e.models).toHaveLength(2);
    expect(e.apiFormat satisfies CustomApiFormat).toBe('openai-completions');
  });
});