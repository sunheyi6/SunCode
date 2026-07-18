/**
 * Completion Gate — bounded post-edit verification before run finalization.
 *
 * Aligns with maka-agent Self-check principles (desktop-scoped):
 * - Model saying "done" is not authority
 * - Evidence comes from real tool results (bash exit codes), not free-text claims
 * - At most one repair turn after code changes without a passing check
 *
 * This is a smoke-check discipline gate, not official task correctness scoring.
 */

import type { AppSettings, ToolCallContent, ToolResult } from '@shared/types';

/** Default max repair attempts when code changed without verification. */
export const COMPLETION_GATE_MAX_REPAIR_ATTEMPTS = 1;

/**
 * Commands treated as local verification / smoke checks.
 * Prefer package scripts and common language tooling; not arbitrary `ls`/`cat`.
 */
const VERIFICATION_COMMAND_PATTERNS: readonly RegExp[] = [
  /\btypecheck\b/i,
  /\blint\b/i,
  /\bbiome\s+check\b/i,
  /\beslint\b/i,
  /\btsc(\s|$)/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bmocha\b/i,
  /\bpytest\b/i,
  /\bcargo\s+test\b/i,
  /\bgo\s+test\b/i,
  /\bnpm\s+(test|run\s+\S*(test|lint|typecheck|check)\S*)\b/i,
  /\bbun\s+(test|run\s+\S*(test|lint|typecheck|check)\S*)\b/i,
  /\bpnpm\s+(test|run\s+\S*(test|lint|typecheck|check)\S*)\b/i,
  /\byarn\s+(test|run\s+\S*(test|lint|typecheck|check)\S*)\b/i,
  /\bnpx\s+tsc\b/i,
  /\bflutter\s+test\b/i,
  /\bmv?n\s+test\b/i,
  /\bgradlew?\s+test\b/i,
  /\bruff\s+check\b/i,
  /\bprettier\s+--check\b/i,
  /\bdotnet\s+test\b/i,
  /\bphpunit\b/i,
];

const WRITE_TOOL_NAMES = new Set(['edit', 'write']);

export interface CompletionGateState {
  materialChangeMade: boolean;
  /** Turn number of the latest successful write/edit (1-based agent turn). */
  lastMaterialChangeTurn?: number;
  /** True when a verification-like bash command exited 0 after the last write. */
  hasPassingVerificationAfterChange: boolean;
  lastVerificationCommand?: string;
  lastVerificationExitCode?: number | null;
  repairAttemptsUsed: number;
  maxRepairAttempts: number;
}

export type CompletionGateDecision =
  | { action: 'allow'; reason: string }
  | {
      action: 'repair';
      reason: string;
      prompt: string;
      attempt: number;
      maxAttempts: number;
    };

export function createCompletionGateState(
  maxRepairAttempts: number = COMPLETION_GATE_MAX_REPAIR_ATTEMPTS,
): CompletionGateState {
  return {
    materialChangeMade: false,
    hasPassingVerificationAfterChange: false,
    repairAttemptsUsed: 0,
    maxRepairAttempts,
  };
}

/** Whether completion gate should run for this permission mode + settings. */
export function isCompletionGateEnabled(
  settings: Pick<AppSettings, 'permissionMode'> & { completionGateEnabled?: boolean },
): boolean {
  if (settings.completionGateEnabled === false) return false;
  // plan mode is read-only exploration — no deliverable write discipline
  if (settings.permissionMode === 'plan') return false;
  return true;
}

/** Heuristic: is this shell command a local verification / smoke check? */
export function isVerificationCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return VERIFICATION_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Fold tool results from one turn into gate state.
 * Successful write/edit invalidates prior verification until a new check passes.
 */
export function updateCompletionGateFromTools(
  state: CompletionGateState,
  toolResults: readonly ToolResult[],
  turnNumber: number,
): CompletionGateState {
  let next = state;

  for (const result of toolResults) {
    if (result.success && WRITE_TOOL_NAMES.has(result.name)) {
      next = {
        ...next,
        materialChangeMade: true,
        lastMaterialChangeTurn: turnNumber,
        // New edits require a fresh check after the latest change.
        hasPassingVerificationAfterChange: false,
      };
      continue;
    }

    if (result.name !== 'bash') continue;

    const command = extractBashCommand(result);
    if (!command || !isVerificationCommand(command)) continue;

    const exitCode = extractBashExitCode(result);
    next = {
      ...next,
      lastVerificationCommand: command,
      lastVerificationExitCode: exitCode,
    };

    if (exitCode === 0 && result.success && next.materialChangeMade) {
      next = {
        ...next,
        hasPassingVerificationAfterChange: true,
      };
    }
  }

  return next;
}

export function evaluateCompletionGate(state: CompletionGateState): CompletionGateDecision {
  if (!state.materialChangeMade) {
    return { action: 'allow', reason: 'no material code changes in this run' };
  }
  if (state.hasPassingVerificationAfterChange) {
    return {
      action: 'allow',
      reason: `passing verification after edits${
        state.lastVerificationCommand ? `: ${state.lastVerificationCommand}` : ''
      }`,
    };
  }
  if (state.repairAttemptsUsed >= state.maxRepairAttempts) {
    return {
      action: 'allow',
      reason: `completion gate repair cap reached (${state.repairAttemptsUsed}/${state.maxRepairAttempts})`,
    };
  }

  const attempt = state.repairAttemptsUsed + 1;
  return {
    action: 'repair',
    reason: 'code changed without a subsequent passing verification command',
    prompt: renderCompletionGateRepairPrompt(state, attempt),
    attempt,
    maxAttempts: state.maxRepairAttempts,
  };
}

/** Record that a repair turn was injected (bounded budget). */
export function markCompletionGateRepairUsed(state: CompletionGateState): CompletionGateState {
  return {
    ...state,
    repairAttemptsUsed: state.repairAttemptsUsed + 1,
  };
}

export function renderCompletionGateRepairPrompt(
  state: CompletionGateState,
  attempt: number,
): string {
  const lastCmd = state.lastVerificationCommand
    ? `\n最近一次相关命令：\`${state.lastVerificationCommand}\`（exitCode=${String(state.lastVerificationExitCode ?? 'n/a')}）`
    : '\n本轮尚未观察到 typecheck / lint / test 等验证命令的成功退出（exit 0）。';

  return [
    '[完成门闩 · Completion Gate]',
    `本 run 已修改代码，但结束前缺少「改完后」的公开验证证据（有界返工 ${attempt}/${state.maxRepairAttempts}）。`,
    lastCmd,
    '',
    '请在当前工作区实际执行至少一条验证命令（例如 `bun run typecheck`、`bun run lint`、`bun run test`，或项目约定的等价检查），根据失败输出修复问题。',
    '验证通过后再给出最终总结；不要只声称「已检查」而不运行命令。',
    '若环境无法运行检查，请明确说明阻塞原因（缺依赖、非项目根目录等），不要空口完成。',
  ].join('\n');
}

function extractBashCommand(result: ToolResult): string | undefined {
  if (result.details?.type === 'command' && result.details.command) {
    return result.details.command;
  }
  // Fallback: some paths may only put the command in output headers — keep null.
  return undefined;
}

function extractBashExitCode(result: ToolResult): number | null {
  if (result.details?.type === 'command') {
    return result.details.exitCode;
  }
  // success without details: treat as unknown, not as verified exit 0
  return null;
}

/** Test helper: did this tool call list include write tools (pre-execution). */
export function toolCallsIncludeWrite(toolCalls: readonly ToolCallContent[]): boolean {
  return toolCalls.some((tc) => WRITE_TOOL_NAMES.has(tc.name));
}
