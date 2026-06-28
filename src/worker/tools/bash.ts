import { spawn, spawnSync } from 'node:child_process';
import type { ToolResult } from '@shared/types';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BackgroundProcess } from '@shared/types';
import { BaseTool, obj, p } from './types';

/** Resolve the Windows PowerShell executable path.
 *  Uses the full System32 path to avoid ENOENT in environments where
 *  System32 is not in PATH (e.g. Bun/Electron detached processes).
 *  Forward slashes work fine with Node.js spawn on Windows and avoid
 *  source-level escape-sequence issues. */
function getPowerShellPath(): string {
  if (process.platform !== 'win32') return 'powershell.exe';
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return systemRoot + '/System32/WindowsPowerShell/v1.0/powershell.exe';
}

/** Maximum output lines before tail truncation. */
const MAX_OUTPUT_LINES = 2000;
/** Maximum output bytes before tail truncation (50KB). */
const MAX_OUTPUT_BYTES = 50_000;
/** Kill process if stdout + stderr exceeds this (safety valve). */
const OVERFLOW_KILL_BYTES = 200_000;

export interface BashToolCallbacks {
  onBackgroundStart?: (proc: BackgroundProcess) => void;
  onBackgroundComplete?: (pid: number, exitCode: number) => void;
  /** Fired when background process's expected ports become reachable (may fire after tool result is returned). */
  onBackgroundPortsVerified?: (pid: number, ports: number[]) => void;
}

/**
 * Kill a process and all its children (cross-platform).
 */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
    } catch {
      // Ignore errors
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process already dead
      }
    }
  }
}

/**
 * Truncate content from the tail — keep the last N lines/bytes.
 * Suitable for bash output where errors/results are at the END.
 *
 * Returns the truncated content and whether truncation occurred.
 */
function truncateTail(
  content: string,
  maxLines: number,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const lines = content.split('\n');
  const totalBytes = Buffer.byteLength(content, 'utf-8');

  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { text: content, truncated: false };
  }

  // Work backwards from the end, collecting complete lines
  const outputLines: string[] = [];
  let outputBytes = 0;
  let partialFirstLine = false;

  for (let i = lines.length - 1; i >= 0 && outputLines.length < maxLines; i--) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + (outputLines.length > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      // Edge case: haven't added any lines yet but this line exceeds maxBytes.
      // Take the tail of this line up to maxBytes.
      if (outputLines.length === 0) {
        const buf = Buffer.from(lines[i], 'utf-8');
        let start = 0;
        if (buf.length > maxBytes) {
          start = buf.length - maxBytes;
          // Find a valid UTF-8 boundary
          while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
        }
        outputLines.unshift(buf.subarray(start).toString('utf-8'));
        partialFirstLine = true;
      }
      break;
    }
    outputLines.unshift(lines[i]);
    outputBytes += lineBytes;
  }

  const truncated = outputLines.length < lines.length || partialFirstLine;
  const skippedLines = lines.length - outputLines.length;
  const prefix =
    truncated && !partialFirstLine ? `... (${skippedLines} earlier lines skipped)\n` : '';

  return { text: prefix + outputLines.join('\n'), truncated };
}

export function createBashTool(workingDir: string, callbacks?: BashToolCallbacks) {
  return new (class BashTool extends BaseTool {
    readonly name = 'bash';
    readonly description =
      'Executes a shell command and returns its stdout and stderr. The working directory is the project root. Commands have a default timeout of 60 seconds.\n\nIMPORTANT: Each invocation runs in a fresh shell. Use && to chain commands (works on PowerShell and bash).\n\nOn Windows this runs PowerShell (powershell.exe, always preinstalled). PowerShell supports: && for chaining, double quotes for strings with spaces, single quotes for literals, Select-String for searching files (instead of grep), Get-ChildItem for directory listing (instead of ls).\n\nOn Linux/macOS this runs bash.\n\nGit examples that work cross-platform:\n- `git add . && git commit -m "feat(scope): message" && git push`\n- `git status && git log --oneline -5`\n\nSet run_in_background: true for long-running processes (dev servers, etc.). Background processes will keep running and their status is shown in the UI.\n\nOutput is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file.\n\nSecurity: Commands that are obviously destructive (rm -rf /, etc.) will be blocked.';
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

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
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

      const shell = process.platform === 'win32' ? getPowerShellPath() : '/bin/bash';
      const shellArgs =
        process.platform === 'win32'
          ? ['-NoProfile', '-NonInteractive', '-Command', command]
          : ['-c', command];

      // ── Background mode: spawn and detach ──
      if (runInBg) {
        // Capture progress callback before async gap — agent-loop nulls
        // tool.onProgress after execute() resolves, but we keep streaming
        // output for the lifetime of the background process.
        const progress = this.onProgress;

        return new Promise((resolveResult) => {
          let child: ReturnType<typeof spawn>;
          try {
            // Use stdio: 'pipe' (not 'ignore') — GUI apps (Electron) need
            // valid stdio handles to create visible windows on Windows.
            child = spawn(shell, shellArgs, {
              cwd,
              env: process.env,
              stdio: 'pipe',
              detached: true,
            });
            // Close stdin — background processes don't read from it,
            // and an open pipe could cause the child to block.
            child.stdin?.end();
          } catch (error) {
            resolveResult(
              commandFailure(`Failed to start background process: ${(error as Error).message}`),
            );
            return;
          }

          // ── Real-time output streaming for background processes ──
          // Throttle to ~100ms to avoid flooding the IPC channel.
          let progressBuf = '';
          let progressTimer: ReturnType<typeof setTimeout> | null = null;

          const flushProgress = () => {
            if (progressBuf && progress) {
              progress(progressBuf);
              progressBuf = '';
            }
            progressTimer = null;
          };

          const pushProgress = (text: string) => {
            if (!progress) return;
            progressBuf += text;
            if (!progressTimer) {
              progressTimer = setTimeout(flushProgress, 100);
            }
          };

          child.stdout?.on('data', (data: Buffer) => pushProgress(data.toString()));
          child.stderr?.on('data', (data: Buffer) => pushProgress(data.toString()));

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
            // Flush any remaining buffered output
            if (progressTimer) {
              clearTimeout(progressTimer);
              flushProgress();
            }
            callbacks?.onBackgroundComplete?.(startedPid, exitCode);
          };

          child.on('error', (error) => {
            // Startup failure: the process couldn't be spawned at all
            failStartup(error.message);
            notifyComplete(-1);
          });

          child.on('close', (code) => {
            if (!startupSettled) {
              // Exited before spawn event fired — startup failure
              failStartup(`process closed before startup (exit code: ${code ?? 'null'})`);
              notifyComplete(code ?? -1);
              return;
            }
            // Flush remaining progress before notifying completion
            if (progressTimer) {
              clearTimeout(progressTimer);
              flushProgress();
            }
            // Startup succeeded, but the shell process exited.
            // Use exit code as heuristic:
            // - code 0 → command ran to completion (app/dev-server likely started) → keep "running"
            // - code non-zero/null → command failed → notify completion
            if (code !== 0) {
              console.log(`[Bash] PID ${startedPid} exited with code ${code} — notifying completion`);
              notifyComplete(code ?? -1);
            } else {
              console.log(`[Bash] PID ${startedPid} exited with code 0 — keeping as running (app likely started)`);
            }
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
        let killed = false;

        const killWithTree = (pid: number) => {
          killed = true;
          killProcessTree(pid);
        };

        // ── Real-time output streaming for foreground commands ──
        // Throttle to ~100ms to avoid flooding the IPC channel.
        let progressBuf = '';
        let progressTimer: ReturnType<typeof setTimeout> | null = null;

        const flushProgress = () => {
          if (progressBuf && this.onProgress) {
            this.onProgress(progressBuf);
            progressBuf = '';
          }
          progressTimer = null;
        };

        const pushProgress = (text: string) => {
          if (!this.onProgress) return;
          progressBuf += text;
          if (!progressTimer) {
            progressTimer = setTimeout(flushProgress, 100);
          }
        };

        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          stdout += text;
          pushProgress(text);
          if (stdout.length > OVERFLOW_KILL_BYTES && child.pid) {
            killWithTree(child.pid);
          }
        });

        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          stderr += text;
          pushProgress(text);
          if (stderr.length > OVERFLOW_KILL_BYTES && child.pid) {
            killWithTree(child.pid);
          }
        });

        child.on('close', async (code, signal) => {
          // Flush any remaining buffered progress output
          if (progressTimer) {
            clearTimeout(progressTimer);
            flushProgress();
          }

          // Apply tail truncation to stdout and stderr separately
          const stdoutTrunc = truncateTail(stdout, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES);
          const stderrTrunc = truncateTail(stderr, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES);
          const wasTruncated = stdoutTrunc.truncated || stderrTrunc.truncated || killed;

          // Save full output to temp file if truncated
          let fullOutputPath: string | undefined;
          if (wasTruncated) {
            try {
              const id = randomBytes(8).toString('hex');
              fullOutputPath = join(tmpdir(), `suncode-bash-${id}.log`);
              const stream = createWriteStream(fullOutputPath);
              stream.write(stdout);
              if (stderr) {
                stream.write('\n--- STDERR ---\n');
                stream.write(stderr);
              }
              await new Promise<void>((resolveWrite, reject) => {
                stream.end(() => resolveWrite());
                stream.on('error', reject);
              });
            } catch {
              // Ignore temp file write errors
            }
          }

          const parts: string[] = [];
          parts.push(`Command: ${command}`);
          parts.push(`Exit code: ${code !== null ? code : 'null'}`);
          if (signal) parts.push(`Signal: ${signal}`);
          if (killed) parts.push(`(killed: output exceeded ${OVERFLOW_KILL_BYTES / 1024}KB)`);

          if (stdoutTrunc.text) {
            parts.push(`\nSTDOUT:\n${stdoutTrunc.text}`);
          }
          if (stderrTrunc.text) {
            parts.push(`\nSTDERR:\n${stderrTrunc.text}`);
          }
          if (!stdout && !stderr) {
            parts.push('\n(no output)');
          }
          if (fullOutputPath) {
            parts.push(`\n[Full output saved to: ${fullOutputPath}]`);
          }

          resolveResult(
            this.success(parts.join('\n'), {
              type: 'command',
              command,
              cwd,
              exitCode: code,
              signal: signal || undefined,
              stdout: stdoutTrunc.text,
              stderr: stderrTrunc.text,
              ...(fullOutputPath ? { fullOutputPath } : {}),
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
