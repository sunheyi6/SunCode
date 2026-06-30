/**
 * Permission Rules Engine
 *
 * Supports fine-grained tool-level permissions with deny/allow rules,
 * three match modes, and 8-source priority ordering.
 *
 * Key design:
 * - deny rules ALWAYS win over allow (even from lower-priority sources)
 * - Three match modes: exact, prefix (bash:*), wildcard (git*)
 * - Rules eval in three-phase pipeline: deny check → allow check → uncertain
 */

import type { PermissionRule, PermissionRuleSet, RuleMatchMode, RuleSource } from '@shared/types';

// ===== Source Priority =====

const SOURCE_PRIORITY: Record<RuleSource, number> = {
  policySettings: 100,
  userSettings: 90,
  projectSettings: 80,
  localSettings: 70,
  flagSettings: 60,
  cliArg: 50,
  command: 40,
  session: 30,
};

// ===== Match Logic =====

function matchPattern(toolName: string, pattern: string, mode: RuleMatchMode): boolean {
  switch (mode) {
    case 'exact':
      return toolName === pattern;
    case 'prefix':
      // "bash:*" matches "bash" and "bash.anything"
      if (pattern.endsWith(':*')) {
        const prefix = pattern.slice(0, -2);
        return toolName === prefix || toolName.startsWith(prefix + '.');
      }
      return toolName.startsWith(pattern);
    case 'wildcard':
      // Convert simple wildcard pattern to regex
      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      return new RegExp(`^${regexStr}$`).test(toolName);
    default:
      return false;
  }
}

function matchArgFilter(
  params: Record<string, unknown>,
  argFilter?: Record<string, string>,
): boolean {
  if (!argFilter) return true;
  for (const [key, value] of Object.entries(argFilter)) {
    const paramValue = params[key];
    if (paramValue === undefined) return false;
    if (String(paramValue) !== value) return false;
  }
  return true;
}

// ===== RuleSet Implementation =====

export class DefaultPermissionRuleSet implements PermissionRuleSet {
  rules: PermissionRule[] = [];

  constructor(rules: PermissionRule[] = []) {
    this.rules = rules;
  }

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  removeRule(rule: PermissionRule): void {
    this.rules = this.rules.filter(
      (r) =>
        !(
          r.type === rule.type &&
          r.toolPattern === rule.toolPattern &&
          r.matchMode === rule.matchMode &&
          r.source === rule.source
        ),
    );
  }

  resolve(toolName: string, params: Record<string, unknown>): 'allow' | 'deny' | 'uncertain' {
    let denyMatch: PermissionRule | null = null;
    let allowMatch: PermissionRule | null = null;

    for (const rule of this.rules) {
      if (!matchPattern(toolName, rule.toolPattern, rule.matchMode)) continue;
      if (!matchArgFilter(params, rule.argFilter)) continue;

      if (rule.type === 'deny') {
        // Deny rules always win — track the highest-priority deny
        if (!denyMatch || SOURCE_PRIORITY[rule.source] > SOURCE_PRIORITY[denyMatch.source]) {
          denyMatch = rule;
        }
      } else {
        // Allow: track the highest-priority allow
        if (!allowMatch || SOURCE_PRIORITY[rule.source] > SOURCE_PRIORITY[allowMatch.source]) {
          allowMatch = rule;
        }
      }
    }

    // Deny always wins (defense-in-depth)
    if (denyMatch) return 'deny';
    if (allowMatch) return 'allow';
    return 'uncertain';
  }
}

// ===== Rule Loading =====

/**
 * Load permission rules from a JSON file.
 */
export async function loadPermissionRules(filePath: string, source: RuleSource): Promise<PermissionRule[]> {
  try {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);

    if (!Array.isArray(data.rules)) return [];

    return data.rules.map((r: Record<string, unknown>) => ({
      type: r.type as 'allow' | 'deny',
      toolPattern: r.toolPattern as string,
      matchMode: (r.matchMode as RuleMatchMode) || 'exact',
      source,
      argFilter: r.argFilter as Record<string, string> | undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Build a PermissionRuleSet from project-level and user-level rule files.
 */
export async function buildPermissionRuleSet(
  projectRulesPath: string,
  userRulesPath: string,
): Promise<DefaultPermissionRuleSet> {
  const projectRules = await loadPermissionRules(projectRulesPath, 'projectSettings');
  const userRules = await loadPermissionRules(userRulesPath, 'userSettings');

  return new DefaultPermissionRuleSet([...projectRules, ...userRules]);
}

// ===== Check helpers =====

/**
 * Quick check: is this tool call allowed by the rules?
 * Returns:
 *   'allow' — explicitly allowed, skip confirmation
 *   'deny' — explicitly denied, block execution
 *   'uncertain' — no rule matches, fall through to normal permission flow
 */
export function checkPermission(
  ruleSet: PermissionRuleSet | null,
  toolName: string,
  params: Record<string, unknown>,
): 'allow' | 'deny' | 'uncertain' {
  if (!ruleSet || ruleSet.rules.length === 0) return 'uncertain';
  return ruleSet.resolve(toolName, params);
}
