import { describe, expect, it } from 'vitest';
import { BackgroundProcessMonitor } from '../../src/worker/tools/background-process-monitor';

describe('BackgroundProcessMonitor', () => {
  it('reports exit when the monitored PID is no longer alive', () => {
    const exits: Array<{ sessionId: string; pid: number; exitCode: number }> = [];
    const alive = new Set([20]);
    const monitor = new BackgroundProcessMonitor(
      (item, exitCode) => exits.push({ sessionId: item.sessionId, pid: item.process.pid, exitCode }),
      (pid) => alive.has(pid),
    );

    monitor.register('session-1', {
      pid: 10,
      monitorPid: 20,
      command: 'bun run dev',
      startTime: 1000,
      status: 'running',
    });
    monitor.checkOnce();
    expect(exits).toEqual([]);

    alive.delete(20);
    monitor.checkOnce();
    expect(exits).toEqual([{ sessionId: 'session-1', pid: 10, exitCode: -1 }]);
  });

  it('kills and checks the display PID when no monitor PID exists', () => {
    const checked: number[] = [];
    const monitor = new BackgroundProcessMonitor(
      () => {},
      (pid) => {
        checked.push(pid);
        return true;
      },
    );

    monitor.register('session-1', {
      pid: 30,
      command: 'echo hi',
      startTime: 1000,
      status: 'running',
    });
    monitor.checkOnce();

    expect(checked).toEqual([30]);
    monitor.unregister(30);
  });
});
