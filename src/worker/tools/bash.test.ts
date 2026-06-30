import { describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBashTool, rewriteKillCommand } from './bash';

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

  test('blocks global Electron process-name checks as startup evidence', async () => {
    const command =
      'powershell -Command "Get-Process -Name electron -ErrorAction SilentlyContinue | Format-Table Id, ProcessName, StartTime"';
    const result = await createBashTool(process.cwd()).execute({ command });

    expect(result.success).toBe(false);
    expect(result.details).toMatchObject({
      type: 'command',
      command,
      cwd: process.cwd(),
      exitCode: null,
      stderr: expect.stringContaining('Global Electron process-name checks are not valid'),
    });
  });

  test('blocks SunCode startup marker for another project launch', async () => {
    const command = 'cd D:/project/maka-agent && npm run dev';
    const result = await createBashTool(process.cwd()).execute({
      command,
      run_in_background: true,
      background_mode: 'service',
      startup_marker: '[SunCode] STARTUP_COMPLETE',
      readiness_timeout: 120000,
    });

    expect(result.success).toBe(false);
    expect(result.details).toMatchObject({
      type: 'command',
      command,
      cwd: process.cwd(),
      exitCode: null,
      stderr: expect.stringContaining('SunCode startup marker cannot validate another project'),
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

describe('kill command protection', () => {
  const protectedPids = [1234, 5678];

  test('does not modify non-kill commands', () => {
    const result = rewriteKillCommand('echo hello', protectedPids);
    expect(result.rewritten).toBe('echo hello');
    expect(result.modified).toBe(false);
    expect(result.blocked).toBe(false);
  });

  test('rewrites Stop-Process by name to exclude protected PIDs', () => {
    const result = rewriteKillCommand("Stop-Process -Name 'electron' -Force", protectedPids);
    expect(result.modified).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.rewritten).toContain('Where-Object');
    expect(result.rewritten).toContain('1234');
    expect(result.rewritten).toContain('5678');
  });

  test('rewrites Get-Process | Stop-Process pipeline', () => {
    const result = rewriteKillCommand("Get-Process -Name 'node' | Stop-Process", protectedPids);
    expect(result.modified).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.rewritten).toContain('Where-Object');
  });

  test('rewrites the exact crash command with ErrorAction SilentlyContinue', () => {
    const crashCommand = `Get-Process -Name "electron" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`;
    const result = rewriteKillCommand(crashCommand, protectedPids);
    expect(result.modified).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.rewritten).toContain('Where-Object');
    expect(result.rewritten).toContain('1234');
    expect(result.rewritten).toContain('5678');
  });

  test('blocks Stop-Process by protected PID', () => {
    const result = rewriteKillCommand('Stop-Process -Id 1234 -Force', protectedPids);
    expect(result.blocked).toBe(true);
    expect(result.message).toBe('cannot kill protected PID 1234');
  });

  test('allows Stop-Process by non-protected PID', () => {
    const result = rewriteKillCommand('Stop-Process -Id 9999 -Force', protectedPids);
    expect(result.modified).toBe(false);
    expect(result.blocked).toBe(false);
  });

  test('rewrites taskkill /IM by name', () => {
    const result = rewriteKillCommand('taskkill /IM electron.exe /F', protectedPids);
    expect(result.modified).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.rewritten).toContain('Where-Object');
  });

  test('blocks taskkill /PID for protected PID', () => {
    const result = rewriteKillCommand('taskkill /PID 5678 /F', protectedPids);
    expect(result.blocked).toBe(true);
    expect(result.message).toBe('cannot kill protected PID 5678');
  });

  test('rewrites killall on Unix', () => {
    const result = rewriteKillCommand('killall node', protectedPids);
    expect(result.modified).toBe(true);
    expect(result.blocked).toBe(false);
  });

  test('rewrites pkill on Unix', () => {
    const result = rewriteKillCommand('pkill chrome', protectedPids);
    expect(result.modified).toBe(true);
    expect(result.blocked).toBe(false);
  });

  test('blocks kill by protected PID on Unix', () => {
    const result = rewriteKillCommand('kill -9 1234', protectedPids);
    expect(result.blocked).toBe(true);
    expect(result.message).toBe('cannot kill protected PID 1234');
  });

  test('allows kill by non-protected PID on Unix', () => {
    const result = rewriteKillCommand('kill 9999', protectedPids);
    expect(result.modified).toBe(false);
    expect(result.blocked).toBe(false);
  });

  test('does nothing when protectedPids is empty', () => {
    const result = rewriteKillCommand("Stop-Process -Name 'electron'", []);
    expect(result.rewritten).toBe("Stop-Process -Name 'electron'");
    expect(result.modified).toBe(false);
    expect(result.blocked).toBe(false);
  });
});
