import { version } from '../../package.json';

/** OpenCode routes and caches requests by conversation, independently of SDK cache settings. */
export function getProviderHeaders(
  model: unknown,
  sessionId: string,
): Record<string, string> | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const { provider, baseUrl } = model as { provider?: string; baseUrl?: string };
  let isOpenCode = provider === 'opencode' || provider === 'opencode-go';
  if (!isOpenCode && baseUrl) {
    try {
      isOpenCode = new URL(baseUrl).hostname === 'opencode.ai';
    } catch {
      return undefined;
    }
  }
  if (!isOpenCode) return undefined;
  return { 'x-opencode-session': sessionId, 'User-Agent': `SunCode/${version}` };
}
