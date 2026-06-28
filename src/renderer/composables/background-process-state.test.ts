// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import type { BackgroundProcess } from '@shared/types';
import {
  completeProcess,
  formatElapsedTime,
  latestProcess,
  upsertStartedProcess,
} from './background-process-state';

describe('background process state', () => {
  test('replaces duplicate start events by pid', () => {
    const processes: BackgroundProcess[] = [];
    upsertStartedProcess(processes, {
      pid: 7,
      command: 'bun run dev',
      startTime: 1000,
      status: 'running',
    });
    upsertStartedProcess(processes, {
      pid: 7,
      command: 'bun run dev --host',
      startTime: 2000,
      status: 'running',
    });
    expect(processes).toHaveLength(1);
    expect(processes[0].command).toBe('bun run dev --host');
  });

  test('selects the greatest startTime', () => {
    const processes: BackgroundProcess[] = [
      { pid: 1, command: 'older', startTime: 1000, status: 'running' },
      { pid: 2, command: 'newer', startTime: 2000, status: 'running' },
    ];
    expect(latestProcess(processes)?.pid).toBe(2);
  });

  test('records completion time and failure state', () => {
    const processes: BackgroundProcess[] = [
      { pid: 3, command: 'build', startTime: 1000, status: 'running' },
    ];
    completeProcess(processes, 3, 1, 5500);
    expect(processes[0]).toMatchObject({
      status: 'error',
      exitCode: 1,
      endTime: 5500,
    });
  });

  test('formats elapsed time in Chinese', () => {
    expect(formatElapsedTime(0)).toBe('0秒');
    expect(formatElapsedTime(65_000)).toBe('1分 5秒');
    expect(formatElapsedTime(3_900_000)).toBe('1小时 5分');
  });
});
