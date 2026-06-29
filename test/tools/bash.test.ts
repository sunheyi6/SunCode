import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createBashTool } from '../../src/worker/tools/bash';
import type { ChildProcess } from 'node:child_process';

// Mock child_process so tests don't spawn real shells.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
    spawnSync: vi.fn(),
  };
});

import { spawn } from 'node:child_process';

describe('bash tool foreground progress', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('streams stdout chunks through onProgress while running', async () => {
    const mockSpawn = vi.mocked(spawn);

    // Build a fake child process that emits data and then closes.
    const fakeChild = new EventEmitter() as ChildProcess;
    fakeChild.stdout = new EventEmitter() as NodeJS.ReadableStream;
    fakeChild.stderr = new EventEmitter() as NodeJS.ReadableStream;
    fakeChild.stdin = { end: vi.fn() } as unknown as NodeJS.WritableStream;
    fakeChild.pid = 12345;

    mockSpawn.mockReturnValue(fakeChild);

    const tool = createBashTool('/tmp');
    const progressChunks: string[] = [];
    tool.onProgress = (chunk: string) => {
      progressChunks.push(chunk);
    };

    const executePromise = tool.execute({ command: 'echo hello' });

    // Simulate stdout arriving in two chunks.
    (fakeChild.stdout as EventEmitter).emit('data', Buffer.from('hello '));
    (fakeChild.stdout as EventEmitter).emit('data', Buffer.from('world'));

    // Advance timers to let the 100ms throttle fire.
    await vi.advanceTimersByTimeAsync(150);

    (fakeChild as EventEmitter).emit('close', 0, null);

    const result = await executePromise;

    expect(result.success).toBe(true);
    expect(progressChunks.length).toBeGreaterThan(0);
    expect(progressChunks.join('')).toContain('hello world');
  });

  it('captures stderr through onProgress', async () => {
    const mockSpawn = vi.mocked(spawn);

    const fakeChild = new EventEmitter() as ChildProcess;
    fakeChild.stdout = new EventEmitter() as NodeJS.ReadableStream;
    fakeChild.stderr = new EventEmitter() as NodeJS.ReadableStream;
    fakeChild.stdin = { end: vi.fn() } as unknown as NodeJS.WritableStream;
    fakeChild.pid = 12346;

    mockSpawn.mockReturnValue(fakeChild);

    const tool = createBashTool('/tmp');
    const progressChunks: string[] = [];
    tool.onProgress = (chunk: string) => progressChunks.push(chunk);

    const executePromise = tool.execute({ command: 'echo error >&2' });

    (fakeChild.stderr as EventEmitter).emit('data', Buffer.from('something went wrong'));
    await vi.advanceTimersByTimeAsync(150);
    (fakeChild as EventEmitter).emit('close', 1, null);

    const result = await executePromise;

    // Bash tool reports exit code in output but currently returns success=true
    // for all foreground executions; the stderr is still captured.
    expect(result.success).toBe(true);
    expect(result.output).toContain('Exit code: 1');
    expect(result.output).toContain('something went wrong');
    expect(progressChunks.join('')).toContain('something went wrong');
  });
});

describe('bash tool background completion', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function fakeBackgroundChild(pid: number): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    child.stdout = new EventEmitter() as NodeJS.ReadableStream;
    child.stderr = new EventEmitter() as NodeJS.ReadableStream;
    child.stdin = { end: vi.fn() } as unknown as NodeJS.WritableStream;
    child.pid = pid;
    child.unref = vi.fn();
    return child;
  }

  it('notifies completion when a default background task exits with code 0', async () => {
    const mockSpawn = vi.mocked(spawn);
    const fakeChild = fakeBackgroundChild(22334);
    mockSpawn.mockReturnValue(fakeChild);
    const completed: Array<{ pid: number; exitCode: number }> = [];

    const executePromise = createBashTool('/tmp', {
      onBackgroundComplete: (pid, exitCode) => completed.push({ pid, exitCode }),
    }).execute({ command: 'echo done', run_in_background: true });

    fakeChild.emit('spawn');
    await executePromise;
    fakeChild.emit('close', 0, null);

    expect(completed).toEqual([{ pid: 22334, exitCode: 0 }]);
  });

  it('notifies completion when a service launcher shell exits with code 0', async () => {
    const mockSpawn = vi.mocked(spawn);
    const fakeChild = fakeBackgroundChild(22335);
    mockSpawn.mockReturnValue(fakeChild);
    const completed: Array<{ pid: number; exitCode: number }> = [];

    const executePromise = createBashTool('/tmp', {
      onBackgroundComplete: (pid, exitCode) => completed.push({ pid, exitCode }),
    }).execute({
      command: 'start dev server',
      run_in_background: true,
      background_mode: 'service',
    });

    fakeChild.emit('spawn');
    const result = await executePromise;
    fakeChild.emit('close', 0, null);

    expect(result.output).toContain('launch command started');
    expect(result.output).toContain('does not confirm the app is ready');
    expect(completed).toEqual([{ pid: 22335, exitCode: 0 }]);
  });
});
