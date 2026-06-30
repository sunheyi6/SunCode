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

  it('does not leak the host Vite dev server URL into child commands', async () => {
    const mockSpawn = vi.mocked(spawn);
    const previousDevServerUrl = process.env.VITE_DEV_SERVER_URL;
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173';

    const fakeChild = new EventEmitter() as ChildProcess;
    fakeChild.stdout = new EventEmitter() as NodeJS.ReadableStream;
    fakeChild.stderr = new EventEmitter() as NodeJS.ReadableStream;
    fakeChild.stdin = { end: vi.fn() } as unknown as NodeJS.WritableStream;
    fakeChild.pid = 12347;

    mockSpawn.mockReturnValue(fakeChild);

    try {
      const executePromise = createBashTool('/tmp').execute({ command: 'echo hello' });
      (fakeChild as EventEmitter).emit('close', 0, null);
      await executePromise;

      const options = mockSpawn.mock.calls[0]?.[2];
      expect(options?.env).toMatchObject({
        PATH: expect.any(String),
      });
      expect(options?.env).not.toHaveProperty('VITE_DEV_SERVER_URL');
    } finally {
      if (previousDevServerUrl === undefined) {
        delete process.env.VITE_DEV_SERVER_URL;
      } else {
        process.env.VITE_DEV_SERVER_URL = previousDevServerUrl;
      }
    }
  });
});

describe('bash tool background completion', () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it('waits for a service startup marker before resolving readiness', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mockSpawn = vi.mocked(spawn);
    const fakeChild = fakeBackgroundChild(22336);
    mockSpawn.mockReturnValue(fakeChild);

    let settled = false;
    const executePromise = createBashTool('/tmp').execute({
      command: 'npm run dev',
      run_in_background: true,
      background_mode: 'service',
      startup_marker: 'ready in',
      readiness_timeout: 5000,
    });
    executePromise.then(() => {
      settled = true;
    });

    fakeChild.emit('spawn');
    await vi.advanceTimersByTimeAsync(150);
    expect(settled).toBe(false);

    (fakeChild.stdout as EventEmitter).emit('data', Buffer.from('VITE ready in 123ms'));
    const result = await executePromise;

    expect(result.success).toBe(true);
    expect(result.output).toContain('ready');
    expect(result.output).toContain('startup marker');
  });

  it('fails service readiness when the process exits before the startup marker appears', async () => {
    const mockSpawn = vi.mocked(spawn);
    const fakeChild = fakeBackgroundChild(22337);
    mockSpawn.mockReturnValue(fakeChild);

    const executePromise = createBashTool('/tmp').execute({
      command: 'npm run dev',
      run_in_background: true,
      background_mode: 'service',
      startup_marker: 'ready in',
    });

    fakeChild.emit('spawn');
    (fakeChild.stdout as EventEmitter).emit('data', Buffer.from('building...'));
    fakeChild.emit('close', 0, null);
    const result = await executePromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('exited before startup marker');
    expect(result.details).toMatchObject({
      type: 'command',
      command: 'npm run dev',
      exitCode: 0,
      stdout: expect.stringContaining('building'),
    });
  });

  it('waits for readiness timeout without a marker before returning launch-only status', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mockSpawn = vi.mocked(spawn);
    const fakeChild = fakeBackgroundChild(22338);
    mockSpawn.mockReturnValue(fakeChild);

    let settled = false;
    const executePromise = createBashTool('/tmp').execute({
      command: 'npm run dev',
      run_in_background: true,
      background_mode: 'service',
      readiness_timeout: 5000,
    });
    executePromise.then(() => {
      settled = true;
    });

    fakeChild.emit('spawn');
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(4000);
    const result = await executePromise;

    expect(result.success).toBe(true);
    expect(result.output).toContain('still running after readiness wait');
    expect(result.output).toContain('does not confirm the app is ready');
  });

  it('treats a zero-exit service launcher without a marker as launch-only status', async () => {
    const mockSpawn = vi.mocked(spawn);
    const fakeChild = fakeBackgroundChild(22339);
    mockSpawn.mockReturnValue(fakeChild);

    const executePromise = createBashTool('/tmp').execute({
      command: 'npm run dev',
      run_in_background: true,
      background_mode: 'service',
      readiness_timeout: 5000,
    });

    fakeChild.emit('spawn');
    fakeChild.emit('close', 0, null);
    const result = await executePromise;

    expect(result.success).toBe(true);
    expect(result.output).toContain('launcher exited with code 0');
    expect(result.output).toContain('does not confirm the app is ready');
    expect(result.details).toMatchObject({
      type: 'command',
      command: 'npm run dev',
      exitCode: 0,
    });
  });
});
