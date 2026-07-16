import type { AppSettings } from '@shared/types';

export const SUBAGENT_BUDGET = {
  maxTurns: 8,
  maxWallTimeMs: 60_000,
  maxInputTokens: 100_000,
  maxToolCalls: 20,
} as const;

export function resolveSubagentMaxTurns(definitionMaxTurns?: number): number {
  const requested = definitionMaxTurns ?? SUBAGENT_BUDGET.maxTurns;
  return Math.max(1, Math.min(requested, SUBAGENT_BUDGET.maxTurns));
}

export function resolveSubagentThinkingLevel(
  parentLevel: AppSettings['thinkingLevel'],
  definitionLevel?: string,
): AppSettings['thinkingLevel'] {
  const allowed: AppSettings['thinkingLevel'][] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  const requested = allowed.includes(definitionLevel as AppSettings['thinkingLevel'])
    ? (definitionLevel as AppSettings['thinkingLevel'])
    : parentLevel;
  return requested === 'xhigh' || requested === 'high' ? 'medium' : requested;
}
