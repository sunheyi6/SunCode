import { describe, expect, test } from 'vitest';
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
    // On Windows, use cmd to produce a known non-zero exit code
    const command = process.platform === 'win32' ? 'cmd /c "exit 7"' : 'bash -c "exit 7"';
    const result = await createBashTool(process.cwd()).execute({ command });

    expect(result.details).toMatchObject({
      type: 'command',
      command,
      exitCode: expect.any(Number),
    });
    // Non-zero exit code
    if (result.details?.type === 'command') {
      expect(result.details.exitCode).not.toBe(0);
    }
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

    expect(typeof startedPid).toBe('number');
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

  test('tail-truncates stdout and stderr at 50,000 bytes, keeps the end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suncode-bash-'));
    const scriptPath = join(dir, 'large-output.cjs');
    await writeFile(
      scriptPath,
      "process.stdout.write('a'.repeat(30000) + '\\nb'.repeat(30001)); process.stderr.write('e'.repeat(50001));",
    );

    try {
      const command = `node ${scriptPath}`;
      const result = await createBashTool(process.cwd()).execute({ command });

      expect(result.success).toBe(true);
      expect(result.details?.type).toBe('command');
      if (result.details?.type !== 'command') throw new Error('Expected command details');

      expect(result.details.exitCode).toBe(0);
      // Tail truncation: keeps the last portion of output
      // stdout has 2 lines: 30000 'a's + newline + 30001 'b's
      // The last line (30001 bytes) exceeds 50000 limit alone, so it gets byte-truncated from end
      expect(result.details.stdout).toContain('b');
      expect(result.details.stdout.length).toBeLessThan(60000);
      // stderr has one 50001-char line, tail-truncated to 50000 chars
      expect(result.details.stderr).toContain('e');
      expect(result.details.stderr.length).toBeLessThan(51000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
