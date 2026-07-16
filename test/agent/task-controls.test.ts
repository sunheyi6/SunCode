import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { ToolCallContent, ToolResult } from '@shared/types';
import {
  createProgressGuardState,
  SIMPLE_TASK_FORCED_FINISH_TURNS,
  SIMPLE_TASK_PROGRESS_HARD_TURNS,
  SIMPLE_TASK_PROGRESS_WARNING_TURNS,
  updateSimpleTaskProgressGuard,
} from '../../src/worker/agent/progress-guard';
import {
  resolveSubagentMaxTurns,
  resolveSubagentThinkingLevel,
  SUBAGENT_BUDGET,
} from '../../src/worker/agent/subagent-budget';
import {
  applyOrdinaryTaskPolicy,
  isSimpleTask,
  SIMPLE_TASK_MAX_TURNS,
} from '../../src/worker/agent/task-policy';

const readCall: ToolCallContent = {
  type: 'tool_call',
  id: 'read-1',
  name: 'read',
  arguments: '{}',
};

function result(name: string, success = true): ToolResult {
  return {
    toolCallId: `${name}-1`,
    name,
    success,
    output: success ? 'ok' : '',
    error: success ? undefined : 'failed',
  };
}

describe('ordinary task policy', () => {
  it('recognizes a short UI color edit but not a complex architecture task', () => {
    expect(isSimpleTask('右侧顶部按钮颜色和窗口栏保持一致')).toBe(true);
    expect(isSimpleTask('分析并修复并发竞态导致的数据丢失根因')).toBe(false);
  });

  it('caps simple tasks and lowers xhigh without changing complex tasks', () => {
    const settings = { ...DEFAULT_SETTINGS, maxTurns: 200, thinkingLevel: 'xhigh' as const };
    const simple = applyOrdinaryTaskPolicy(settings, '把按钮颜色改成白色');
    const complex = applyOrdinaryTaskPolicy(settings, '分析并发架构和性能问题');

    expect(simple.maxTurns).toBe(SIMPLE_TASK_MAX_TURNS);
    expect(simple.thinkingLevel).toBe('medium');
    expect(complex).toBe(settings);
  });
});

describe('simple task progress guard', () => {
  it('warns after repeated investigation and then tightens the finish budget', () => {
    let state = createProgressGuardState();
    let warning: string | undefined;
    let forcedTurns: number | undefined;

    for (let turn = 1; turn <= SIMPLE_TASK_PROGRESS_HARD_TURNS; turn++) {
      const update = updateSimpleTaskProgressGuard(state, [readCall], [result('read')]);
      state = update.state;
      if (turn === SIMPLE_TASK_PROGRESS_WARNING_TURNS) warning = update.guidance;
      if (turn === SIMPLE_TASK_PROGRESS_HARD_TURNS) {
        forcedTurns = update.forceFinishWithinTurns;
      }
    }

    expect(warning).toContain('收敛');
    expect(forcedTurns).toBe(SIMPLE_TASK_FORCED_FINISH_TURNS);
  });

  it('disarms after a successful edit', () => {
    let state = createProgressGuardState();
    state = updateSimpleTaskProgressGuard(state, [readCall], [result('read')]).state;
    const editCall = { ...readCall, id: 'edit-1', name: 'edit' };
    state = updateSimpleTaskProgressGuard(state, [editCall], [result('edit')]).state;

    expect(state.materialChangeMade).toBe(true);
    expect(state.investigationTurns).toBe(0);
  });
});

describe('subagent budget', () => {
  it('enforces hard independent limits and avoids high thinking by default', () => {
    expect(resolveSubagentMaxTurns(50)).toBe(SUBAGENT_BUDGET.maxTurns);
    expect(resolveSubagentMaxTurns(3)).toBe(3);
    expect(resolveSubagentThinkingLevel('xhigh')).toBe('medium');
    expect(resolveSubagentThinkingLevel('low', 'high')).toBe('medium');
  });
});
