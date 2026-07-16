import type { ToolCallContent, ToolResult } from '@shared/types';

export const SIMPLE_TASK_PROGRESS_WARNING_TURNS = 8;
export const SIMPLE_TASK_PROGRESS_HARD_TURNS = 12;
export const SIMPLE_TASK_FORCED_FINISH_TURNS = 2;

export interface ProgressGuardState {
  investigationTurns: number;
  materialChangeMade: boolean;
  warned: boolean;
  hardLimitApplied: boolean;
}

export interface ProgressGuardUpdate {
  state: ProgressGuardState;
  guidance?: string;
  forceFinishWithinTurns?: number;
}

export function createProgressGuardState(): ProgressGuardState {
  return {
    investigationTurns: 0,
    materialChangeMade: false,
    warned: false,
    hardLimitApplied: false,
  };
}

/**
 * Small edits should not spend dozens of turns only gathering more evidence.
 * A successful edit/write ends the guard; until then every tool round counts
 * as investigation, including failed attempts and delegated exploration.
 */
export function updateSimpleTaskProgressGuard(
  state: ProgressGuardState,
  toolCalls: ToolCallContent[],
  toolResults: ToolResult[],
): ProgressGuardUpdate {
  if (state.materialChangeMade || toolCalls.length === 0) return { state };

  const materialChangeMade = toolResults.some(
    (result) => result.success && (result.name === 'edit' || result.name === 'write'),
  );
  if (materialChangeMade) {
    return {
      state: { ...state, materialChangeMade: true, investigationTurns: 0 },
    };
  }

  const next: ProgressGuardState = {
    ...state,
    investigationTurns: state.investigationTurns + 1,
  };

  if (next.investigationTurns >= SIMPLE_TASK_PROGRESS_HARD_TURNS && !next.hardLimitApplied) {
    next.hardLimitApplied = true;
    return {
      state: next,
      guidance:
        '[系统进度约束] 这个小改动已经连续多轮没有产生成功的文件修改。停止扩大搜索范围。请在当前证据下立即执行最可信的修改；如果证据不足以安全修改，请直接说明具体阻塞，不要继续重复调查。',
      forceFinishWithinTurns: SIMPLE_TASK_FORCED_FINISH_TURNS,
    };
  }

  if (next.investigationTurns >= SIMPLE_TASK_PROGRESS_WARNING_TURNS && !next.warned) {
    next.warned = true;
    return {
      state: next,
      guidance:
        '[系统进度提醒] 这个小改动已经连续多轮只在调查，尚未产生成功的文件修改。请收敛到当前最可信的根因，优先修改并运行针对性验证，不要继续扩大搜索范围。',
    };
  }

  return { state: next };
}
