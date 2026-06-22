import { describe, expect, test } from 'bun:test';
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
});
