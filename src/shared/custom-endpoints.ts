import type { CustomApiFormat } from './types';

const API_PATH_SUFFIXES: Record<CustomApiFormat, string> = {
  'openai-completions': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/messages',
};

/** 将用户误填的完整接口地址归一化为 SDK 需要的 base URL。 */
export function normalizeCustomEndpointBaseUrl(
  baseUrl: string,
  apiFormat: CustomApiFormat,
): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const suffix = API_PATH_SUFFIXES[apiFormat];
  return trimmed.toLowerCase().endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
}
