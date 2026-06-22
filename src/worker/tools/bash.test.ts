// @ts-expect-error Bun test types are provided by the Bun runtime.
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBashTool } from './bash';

describe('bash tool details', () => {
  test('returns command metadata and stdout', async () => {
    const command = process.platform === 'win32' ? 'echo hello' : "printf 'hello\\n'";
    const result = await createBashTool(process.cwd()).execute({ command });

    expect(result.details).toMatchObject({
      type: 'command',
      command,
      cwd: process.cwd(),
      exitCode: 0,
      stderr: '',
    });
    expect(result.details?.type === 'command' && result.details.stdout).toContain('hello');
  });

  test('retains a non-zero exit code', async () => {
    const command = process.platform === 'win32' ? 'exit /b 7' : 'exit 7';
    const result = await createBashTool(process.cwd()).execute({ command });

    expect(result.details).toMatchObject({
      type: 'command',
      command,
      exitCode: 7,
    });
  });

  test('returns command details when validation fails', async () => {
    const result = await createBashTool(process.cwd()).execute({});

    expect(result.success).toBe(false);
    expect(result.details).toEqual({
      type: 'command',
      command: '',
      cwd: process.cwd(),
      exitCode: null,
      stdout: '',
      stderr: 'command is required',
    });
  });

  test('returns command details when a dangerous command is blocked', async () => {
    const command = 'rm -rf /';
    const result = await createBashTool(process.cwd()).execute({ command });

    expect(result.success).toBe(false);
    expect(result.details).toMatchObject({
      type: 'command',
      command,
      cwd: process.cwd(),
      exitCode: null,
      stderr: expect.stringContaining('dangerous pattern'),
    });
  });

  test('background start preserves callbacks and returns command details', async () => {
    let startedPid: number | undefined;
    const command =
      process.platform === 'win32' ? 'ping 127.0.0.1 -n 2 > nul' : "sh -c 'sleep 0.1'";
    const result = await createBashTool(process.cwd(), {
      onBackgroundStart: (process) => {
        startedPid = process.pid;
      },
    }).execute({ command, run_in_background: true });

    expect(startedPid).toBeNumber();
    expect(result.success).toBe(true);
    expect(result.output).toContain(`PID: ${startedPid}`);
    expect(result.details).toEqual({
      type: 'command',
      command,
      cwd: process.cwd(),
      exitCode: null,
      stdout: '',
      stderr: '',
    });
  });

  test('returns structured details when foreground process startup fails', async () => {
    const invalidCwd = `${process.cwd()}-missing-foreground`;
    const command = 'echo unreachable';
    const result = await createBashTool(invalidCwd).execute({ command });

    expect(result.success).toBe(false);
    expect(result.details).toEqual({
      type: 'command',
      command,
      cwd: invalidCwd,
      exitCode: null,
      stdout: '',
      stderr: expect.stringContaining('Command execution failed:'),
    });
  });

  test('returns structured details when background process startup fails', async () => {
    const invalidCwd = `${process.cwd()}-missing-background`;
    const command = 'echo unreachable';
    const result = await createBashTool(invalidCwd).execute({
      command,
      run_in_background: true,
    });

    expect(result.success).toBe(false);
    expect(result.details).toEqual({
      type: 'command',
      command,
      cwd: invalidCwd,
      exitCode: null,
      stdout: '',
      stderr: expect.stringContaining('Failed to start background process:'),
    });
  });

  test('truncates structured stdout and stderr at 50,000 characters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suncode-bash-'));
    const scriptPath = join(dir, 'large-output.cjs');
    await writeFile(
      scriptPath,
      "process.stdout.write('o'.repeat(50001)); process.stderr.write('e'.repeat(50001));",
    );

    try {
      const command = `node ${scriptPath}`;
      const result = await createBashTool(process.cwd()).execute({ command });

      expect(result.success).toBe(true);
      expect(result.details?.type).toBe('command');
      if (result.details?.type !== 'command') throw new Error('Expected command details');

      expect(result.details.exitCode).toBe(0);
      expect(result.details.stdout).toBe(`${'o'.repeat(50_000)}\n... (output truncated)`);
      expect(result.details.stderr).toBe(`${'e'.repeat(50_000)}\n... (stderr truncated)`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
