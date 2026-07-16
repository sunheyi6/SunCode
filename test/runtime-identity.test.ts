import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  readRuntimeIdentityEnvironment,
  runtimeIdentityEnvironment,
} from '@shared/runtime-identity';
import type { AppRuntimeIdentity } from '@shared/types';
import { DiagLogger } from '../src/worker/utils/diag-logger';

const ENV_KEYS = [
  'SUNCODE_APP_DATA',
  'SUNCODE_APP_INSTANCE_ID',
  'SUNCODE_APP_MODE',
  'SUNCODE_APP_VERSION',
  'SUNCODE_MAIN_PID',
] as const;

const originalEnvironment = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('runtime identity', () => {
  test('round-trips application identity through worker environment variables', () => {
    const identity: AppRuntimeIdentity = {
      appInstanceId: 'instance-test',
      appMode: 'production',
      appVersion: '1.2.3',
      mainPid: 4321,
    };

    const env = runtimeIdentityEnvironment(identity);

    expect(readRuntimeIdentityEnvironment(env, 7)).toEqual({
      ...identity,
      workerThreadId: 7,
    });
  });

  test('rejects incomplete identity instead of attributing logs to the wrong instance', () => {
    expect(
      readRuntimeIdentityEnvironment({
        SUNCODE_APP_INSTANCE_ID: 'instance-test',
        SUNCODE_APP_MODE: 'production',
        SUNCODE_APP_VERSION: '1.2.3',
      }),
    ).toBeUndefined();
  });

  test('writes the application and worker identity at the start of a diagnostic log', () => {
    const appDataDir = mkdtempSync(join(tmpdir(), 'suncode-runtime-'));
    const identity: AppRuntimeIdentity = {
      appInstanceId: 'instance-diagnostic',
      appMode: 'development',
      appVersion: '2.0.0',
      mainPid: 9876,
    };
    Object.assign(process.env, runtimeIdentityEnvironment(identity), {
      SUNCODE_APP_DATA: appDataDir,
    });

    try {
      const logger = new DiagLogger('D:\\project', 'run-test');
      const content = readFileSync(logger.getPath(), 'utf-8');

      expect(content).toContain('[INSTANCE] runtime identity');
      expect(content).toContain('appInstanceId=instance-diagnostic');
      expect(content).toContain('appMode=development');
      expect(content).toContain('appVersion=2.0.0');
      expect(content).toContain('mainPid=9876');
      expect(content).toContain('workerThreadId=0');
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });
});
