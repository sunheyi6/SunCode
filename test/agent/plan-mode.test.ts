import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  enterPlanMode,
  exitPlanMode,
  getPlanPermissionMode,
  getPlanState,
  isPlanModeActive,
  isToolAllowedInPlanMode,
} from '../../src/worker/agent/plan-mode';

let entered = false;

afterEach(() => {
  if (entered && isPlanModeActive()) {
    exitPlanMode(true);
  }
  entered = false;
});

describe('plan mode state', () => {
  it('keeps plan mode active when approval is rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'suncode-plan-'));
    try {
      enterPlanMode(dir, 'full_access');
      entered = true;

      expect(exitPlanMode(false)).toBe('plan');
      expect(isPlanModeActive()).toBe(true);
      expect(getPlanPermissionMode()).toBe('plan');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows only read tools and the active plan file while exploring', () => {
    const dir = mkdtempSync(join(tmpdir(), 'suncode-plan-'));
    try {
      const state = enterPlanMode(dir, 'full_access');
      entered = true;

      expect(isToolAllowedInPlanMode('read', {})).toBe(true);
      expect(isToolAllowedInPlanMode('ExitPlanMode', {})).toBe(true);
      expect(isToolAllowedInPlanMode('write', { file_path: state.planFilePath })).toBe(true);
      expect(isToolAllowedInPlanMode('write', { file_path: join(dir, 'src', 'app.ts') })).toBe(false);
      expect(getPlanState()?.planFilePath).toBe(state.planFilePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates plan files under the session app data directory when available', () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'suncode-plan-workspace-'));
    const appDataDir = mkdtempSync(join(tmpdir(), 'suncode-plan-appdata-'));
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      const state = enterPlanMode(workingDir, 'full_access', undefined, 'session-1');
      entered = true;

      expect(state.planFilePath.startsWith(join(appDataDir, 'sessions', 'session-1', 'plans'))).toBe(
        true,
      );
      expect(existsSync(join(workingDir, '.suncode'))).toBe(false);
    } finally {
      if (entered && isPlanModeActive()) {
        exitPlanMode(true);
      }
      entered = false;
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });
});
