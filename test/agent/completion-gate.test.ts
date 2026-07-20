import { describe, expect, it } from 'vitest';
import {
  createCompletionGateState,
  evaluateCompletionGate,
  isCompletionGateEnabled,
  isVerificationCommand,
  markCompletionGateRepairUsed,
  rebuildCompletionGateFromEvidence,
  updateCompletionGateFromEvidence,
  updateCompletionGateFromTools,
} from '../../src/worker/agent/completion-gate';
import type { ToolResult, TurnEvidenceEnvelope } from '../../src/shared/types';
import { projectToolResultsToEvidence } from '../../src/worker/agent/turn-evidence';

function writeResult(id = 'w1'): ToolResult {
  return {
    toolCallId: id,
    name: 'write',
    success: true,
    output: 'wrote file',
  };
}

function editResult(id = 'e1'): ToolResult {
  return {
    toolCallId: id,
    name: 'edit',
    success: true,
    output: 'edited file',
  };
}

function bashResult(
  command: string,
  exitCode: number | null,
  success = exitCode === 0,
  id = 'b1',
): ToolResult {
  return {
    toolCallId: id,
    name: 'bash',
    success,
    output: success ? 'ok' : 'fail',
    details: {
      type: 'command',
      command,
      cwd: '/tmp',
      exitCode,
      stdout: success ? 'ok' : 'fail',
      stderr: '',
    },
  };
}

describe('isVerificationCommand', () => {
  it('accepts common project check commands', () => {
    expect(isVerificationCommand('bun run typecheck')).toBe(true);
    expect(isVerificationCommand('bun run lint')).toBe(true);
    expect(isVerificationCommand('npx biome check --changed')).toBe(true);
    expect(isVerificationCommand('npm test')).toBe(true);
    expect(isVerificationCommand('npx tsc --noEmit')).toBe(true);
    expect(isVerificationCommand('vitest run')).toBe(true);
    expect(isVerificationCommand('cargo test')).toBe(true);
  });

  it('rejects non-verification shell noise', () => {
    expect(isVerificationCommand('ls -la')).toBe(false);
    expect(isVerificationCommand('cat package.json')).toBe(false);
    expect(isVerificationCommand('git status')).toBe(false);
    expect(isVerificationCommand('echo done')).toBe(false);
  });
});

describe('isCompletionGateEnabled', () => {
  it('defaults on for write-capable modes', () => {
    expect(isCompletionGateEnabled({ permissionMode: 'full_access' })).toBe(true);
    expect(isCompletionGateEnabled({ permissionMode: 'auto_edit' })).toBe(true);
    expect(isCompletionGateEnabled({ permissionMode: 'confirm_changes' })).toBe(true);
  });

  it('is off in plan mode or when explicitly disabled', () => {
    expect(isCompletionGateEnabled({ permissionMode: 'plan' })).toBe(false);
    expect(
      isCompletionGateEnabled({ permissionMode: 'full_access', completionGateEnabled: false }),
    ).toBe(false);
  });
});

describe('completion gate state machine', () => {
  it('allows finish when no material edits occurred', () => {
    const state = createCompletionGateState();
    const next = updateCompletionGateFromTools(
      state,
      [bashResult('bun run typecheck', 0)],
      1,
    );
    expect(evaluateCompletionGate(next)).toMatchObject({ action: 'allow' });
  });

  it('blocks once after write without verification', () => {
    let state = createCompletionGateState();
    state = updateCompletionGateFromTools(state, [writeResult()], 1);
    const decision = evaluateCompletionGate(state);
    expect(decision.action).toBe('repair');
    if (decision.action === 'repair') {
      expect(decision.attempt).toBe(1);
      expect(decision.maxAttempts).toBe(1);
      expect(decision.prompt).toContain('Completion Gate');
    }
  });

  it('allows finish after write + passing verification command', () => {
    let state = createCompletionGateState();
    state = updateCompletionGateFromTools(state, [editResult()], 1);
    state = updateCompletionGateFromTools(state, [bashResult('bun run typecheck', 0)], 2);
    expect(evaluateCompletionGate(state)).toMatchObject({ action: 'allow' });
    expect(state.hasPassingVerificationAfterChange).toBe(true);
  });

  it('invalidates verification when a later edit succeeds', () => {
    let state = createCompletionGateState();
    state = updateCompletionGateFromTools(state, [writeResult()], 1);
    state = updateCompletionGateFromTools(state, [bashResult('bun run lint', 0)], 2);
    expect(state.hasPassingVerificationAfterChange).toBe(true);
    state = updateCompletionGateFromTools(state, [editResult('e2')], 3);
    expect(state.hasPassingVerificationAfterChange).toBe(false);
    expect(evaluateCompletionGate(state).action).toBe('repair');
  });

  it('does not treat failed verification as evidence', () => {
    let state = createCompletionGateState();
    state = updateCompletionGateFromTools(state, [writeResult()], 1);
    state = updateCompletionGateFromTools(state, [bashResult('bun run typecheck', 1, false)], 2);
    expect(state.hasPassingVerificationAfterChange).toBe(false);
    expect(evaluateCompletionGate(state).action).toBe('repair');
  });

  it('does not accept non-verification bash as evidence', () => {
    let state = createCompletionGateState();
    state = updateCompletionGateFromTools(state, [writeResult()], 1);
    state = updateCompletionGateFromTools(state, [bashResult('ls src', 0)], 2);
    expect(evaluateCompletionGate(state).action).toBe('repair');
  });

  it('allows finish after repair budget is exhausted', () => {
    let state = createCompletionGateState();
    state = updateCompletionGateFromTools(state, [writeResult()], 1);
    expect(evaluateCompletionGate(state).action).toBe('repair');
    state = markCompletionGateRepairUsed(state);
    expect(state.repairAttemptsUsed).toBe(1);
    expect(evaluateCompletionGate(state)).toMatchObject({
      action: 'allow',
      reason: expect.stringContaining('repair cap'),
    });
  });
});

describe('updateCompletionGateFromEvidence', () => {
  function evidenceFromTools(tools: ToolResult[], turnId: string): TurnEvidenceEnvelope[] {
    return projectToolResultsToEvidence({
      sessionId: 's',
      turnId,
      toolResults: tools,
    });
  }

  it('blocks after write evidence without verification', () => {
    let state = createCompletionGateState();
    state = updateCompletionGateFromEvidence(state, evidenceFromTools([writeResult()], 'turn-1'), 1);
    expect(evaluateCompletionGate(state).action).toBe('repair');
  });

  it('allows after write + passing verification evidence', () => {
    let state = createCompletionGateState();
    state = updateCompletionGateFromEvidence(state, evidenceFromTools([editResult()], 'turn-1'), 1);
    state = updateCompletionGateFromEvidence(
      state,
      evidenceFromTools([bashResult('bun run typecheck', 0)], 'turn-2'),
      2,
    );
    expect(evaluateCompletionGate(state).action).toBe('allow');
    expect(state.hasPassingVerificationAfterChange).toBe(true);
  });

  it('rebuildCompletionGateFromEvidence preserves repairAttemptsUsed', () => {
    const envelopes = [
      ...evidenceFromTools([writeResult()], 'turn-1'),
      ...evidenceFromTools([bashResult('bun run typecheck', 0)], 'turn-2'),
    ];
    let state = createCompletionGateState();
    state = markCompletionGateRepairUsed(state);
    state = rebuildCompletionGateFromEvidence(state, envelopes);
    expect(state.repairAttemptsUsed).toBe(1);
    expect(state.hasPassingVerificationAfterChange).toBe(true);
    expect(evaluateCompletionGate(state).action).toBe('allow');
  });
});
