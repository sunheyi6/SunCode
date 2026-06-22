import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { BackgroundProcess } from '@shared/types';
import { BaseTool, obj, p } from './types';

export interface BashToolCallbacks {
  onBackgroundStart?: (proc: BackgroundProcess) => void;
  onBackgroundComplete?: (pid: number, exitCode: number) => void;
}

export function createBashTool(workingDir: string, callbacks?: BashToolCallbacks) {
  return new (class BashTool extends BaseTool {
    readonly name = 'bash';
    readonly description =
      'Executes a bash command and returns its stdout and stderr. The working directory is the project root. Commands have a default timeout of 60 seconds. Use this tool to run tests, build commands, git operations, and other shell tasks.\n\nIMPORTANT: Each invocation runs in a fresh shell. Use && to chain commands.\n\nSet run_in_background: true for long-running processes (dev servers, etc.). Background processes will keep running and their status is shown in the UI.\n\nSecurity: Commands that are obviously destructive (rm -rf /, etc.) will be blocked.';
    readonly parameters = obj(
      {
        command: p('string', 'The bash command to execute'),
        timeout: p('integer', 'Optional timeout in milliseconds (max 300000, default 60000)'),
        description: p(
          'string',
          'A short description of what this command does (5-10 words preferred)',
        ),
        run_in_background: p(
          'boolean',
          'Set to true to run this command in the background (e.g. for dev servers). The command will keep running across turns.',
        ),
      },
      ['command'],
    );

    async execute(params: Record<string, unknown>): Promise<ReturnType<BaseTool['execute']>> {
      const command = (params.command as string) || '';
      const timeout = Math.min((params.timeout as number) || 60000, 300000);
      const runInBg = Boolean(params.run_in_background);
      const cwd = resolve(workingDir);
      const commandFailure = (message: string) =>
        this.failure(message, {
          type: 'command',
          command,
          cwd,
          exitCode: null,
          stdout: '',
          stderr: message,
        });

      if (!command) return commandFailure('command is required');

      // Basic security check
      const dangerousPatterns = [
        /rm\s+-rf\s+\//,
        /mkfs\./,
        /dd\s+if=/,
        />\s*\/dev\/sd/,
        /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/, // fork bomb
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
          return commandFailure('Command blocked for security reasons: dangerous pattern detected');
        }
      }

      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
      const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];

      // ── Background mode: spawn and detach ──
      if (runInBg) {
        try {
          const child = spawn(shell, shellArgs, {
            cwd,
            env: process.env,
            stdio: 'ignore',
            detached: true,
          });

          const pid = child.pid;
          if (!pid) return commandFailure('Failed to get PID for background process');

          // Don't wait for the child — unref so it lives independently
          child.unref();

          const proc: BackgroundProcess = {
            pid,
            command,
            startTime: Date.now(),
            status: 'running',
          };

          // Notify listeners
          callbacks?.onBackgroundStart?.(proc);

          // Listen for completion in the background
          child.on('close', (code) => {
            callbacks?.onBackgroundComplete?.(pid, code ?? -1);
          });
          child.on('error', () => {
            callbacks?.onBackgroundComplete?.(pid, -1);
          });

          return this.success(`Background process started (PID: ${pid})\nCommand: ${command}`, {
            type: 'command',
            command,
            cwd,
            exitCode: null,
            stdout: '',
            stderr: '',
          });
        } catch (error) {
          return commandFailure(`Failed to start background process: ${(error as Error).message}`);
        }
      }

      // ── Foreground mode: wait for completion ──
      return new Promise((resolveResult) => {
        const child = spawn(shell, shellArgs, {
          cwd,
          env: process.env,
          timeout,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
          if (stdout.length > 100_000) {
            child.kill();
          }
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
          if (stderr.length > 100_000) {
            child.kill();
          }
        });

        child.on('close', (code, signal) => {
          const truncateLimit = 50_000;
          const truncatedStdout =
            stdout.length > truncateLimit
              ? `${stdout.slice(0, truncateLimit)}\n... (output truncated)`
              : stdout;
          const truncatedStderr =
            stderr.length > truncateLimit
              ? `${stderr.slice(0, truncateLimit)}\n... (stderr truncated)`
              : stderr;

          const parts: string[] = [];
          parts.push(`Command: ${command}`);
          parts.push(`Exit code: ${code !== null ? code : 'null'}`);
          if (signal) parts.push(`Signal: ${signal}`);

          if (truncatedStdout) {
            parts.push(`\nSTDOUT:\n${truncatedStdout}`);
          }
          if (truncatedStderr) {
            parts.push(`\nSTDERR:\n${truncatedStderr}`);
          }
          if (!truncatedStdout && !truncatedStderr) {
            parts.push('\n(no output)');
          }

          resolveResult(
            this.success(parts.join('\n'), {
              type: 'command',
              command,
              cwd,
              exitCode: code,
              signal: signal || undefined,
              stdout: truncatedStdout,
              stderr: truncatedStderr,
            }),
          );
        });

        child.on('error', (error) => {
          resolveResult(commandFailure(`Command execution failed: ${error.message}`));
        });
      });
    }
  })();
}
