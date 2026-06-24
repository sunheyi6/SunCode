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
      'Executes a shell command and returns its stdout and stderr. The working directory is the project root. Commands have a default timeout of 60 seconds.\n\nIMPORTANT: Each invocation runs in a fresh shell. Use && to chain commands (&& works on both Linux/macOS and Windows PowerShell).\n\nThis tool runs PowerShell (pwsh.exe) on Windows and bash on Linux/macOS. Both support standard syntax: double quotes for strings with spaces, && for chaining, single quotes for literals.\n\nGit examples that work cross-platform:\n- `git add . && git commit -m "feat(scope): message" && git push`\n- `git status && git log --oneline -5`\n\nSet run_in_background: true for long-running processes (dev servers, etc.). Background processes will keep running and their status is shown in the UI.\n\nSecurity: Commands that are obviously destructive (rm -rf /, etc.) will be blocked.';
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

      // Use PowerShell on Windows — cmd.exe mangles quotes, parentheses, and special
      // characters that are common in git commit messages (e.g. "feat(scope): msg").
      const shell = process.platform === 'win32' ? 'pwsh.exe' : '/bin/bash';
      const shellArgs =
        process.platform === 'win32'
          ? ['-NoProfile', '-NonInteractive', '-Command', command]
          : ['-c', command];

      // ── Background mode: spawn and detach ──
      if (runInBg) {
        return new Promise((resolveResult) => {
          let child: ReturnType<typeof spawn>;
          try {
            child = spawn(shell, shellArgs, {
              cwd,
              env: process.env,
              stdio: 'ignore',
              detached: true,
            });
          } catch (error) {
            resolveResult(
              commandFailure(`Failed to start background process: ${(error as Error).message}`),
            );
            return;
          }

          let startupSettled = false;
          let startedPid: number | undefined;
          let completionNotified = false;

          const failStartup = (message: string) => {
            if (startupSettled) return;
            startupSettled = true;
            resolveResult(commandFailure(`Failed to start background process: ${message}`));
          };

          const notifyComplete = (exitCode: number) => {
            if (!startedPid || completionNotified) return;
            completionNotified = true;
            callbacks?.onBackgroundComplete?.(startedPid, exitCode);
          };

          child.on('error', (error) => {
            failStartup(error.message);
            notifyComplete(-1);
          });

          child.on('close', (code) => {
            if (!startupSettled) {
              failStartup(`process closed before startup (exit code: ${code ?? 'null'})`);
            }
            notifyComplete(code ?? -1);
          });

          child.once('spawn', () => {
            const pid = child.pid;
            if (!pid) {
              failStartup('Failed to get PID');
              return;
            }

            startupSettled = true;
            startedPid = pid;
            child.unref();

            const proc: BackgroundProcess = {
              pid,
              command,
              startTime: Date.now(),
              status: 'running',
            };
            callbacks?.onBackgroundStart?.(proc);

            resolveResult(
              this.success(`Background process started (PID: ${pid})\nCommand: ${command}`, {
                type: 'command',
                command,
                cwd,
                exitCode: null,
                stdout: '',
                stderr: '',
              }),
            );
          });
        });
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
