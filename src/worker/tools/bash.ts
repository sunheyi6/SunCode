import { spawn } from 'node:child_process';
import type { ToolResult } from '@shared/types';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  return `${systemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe`;
}

/** Maximum output lines before tail truncation. */
const MAX_OUTPUT_LINES = 2000;
/** Maximum output bytes before tail truncation (50KB). */
const MAX_OUTPUT_BYTES = 50_000;
/** Kill process if stdout + stderr exceeds this (safety valve). */
const OVERFLOW_KILL_BYTES = 200_000;
const SERVICE_OBSERVATION_MS = 1000;

interface ProcessEvidence {
  pid: number;
  name: string;
  source: 'CommandLine' | 'ExecutablePath';
}

export interface BashToolCallbacks {
  onBackgroundStart?: (proc: BackgroundProcess) => void;
  onBackgroundComplete?: (pid: number, exitCode: number) => void;
  /** Fired when background process's expected ports become reachable (may fire after tool result is returned). */
  onBackgroundPortsVerified?: (pid: number, ports: number[]) => void;
}

export interface BashToolOptions {
  protectedPids?: number[];
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
    } catch (error) {
      console.warn(`[Bash] Failed to taskkill PID ${pid}:`, (error as Error).message);
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        console.warn(`[Bash] Failed to kill PID ${pid}:`, (error as Error).message);
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

export function rewriteKillCommand(command: string, protectedPids: number[]): { rewritten: string; modified: boolean; blocked: boolean; message?: string } {
  if (!protectedPids || protectedPids.length === 0) {
    return { rewritten: command, modified: false, blocked: false };
  }

  const protectedPidsStr = protectedPids.join(',');

  const winGetProcessPipeStop = /Get-Process\s+-Name\s+(['"])([^'"]+)\1([^|]*)\|\s*Stop-Process/i;
  if (winGetProcessPipeStop.test(command)) {
    const match = command.match(winGetProcessPipeStop);
    if (match) {
      const processName = match[2];
      const rewritten = `$__sc_protect=@(${protectedPidsStr}); Get-Process -Name '${processName}' | Where-Object { $__sc_protect -notcontains $_.Id } | Stop-Process${match[3]}`;
      return { rewritten, modified: true, blocked: false, message: 'modified to protect host process' };
    }
  }

  const winStopProcessByName = /Stop-Process\s+-Name\s+(['"])([^'"]+)\1/i;
  if (winStopProcessByName.test(command)) {
    const match = command.match(winStopProcessByName);
    if (match) {
      const processName = match[2];
      const rewritten = command.replace(
        winStopProcessByName,
        `$__sc_protect=@(${protectedPidsStr}); Get-Process -Name '${processName}' | Where-Object { $__sc_protect -notcontains $_.Id } | Stop-Process`,
      );
      return { rewritten, modified: true, blocked: false, message: 'modified to protect host process' };
    }
  }

  const winStopProcessId = /Stop-Process\s+-Id\s+(\d+)/i;
  if (winStopProcessId.test(command)) {
    const match = command.match(winStopProcessId);
    if (match) {
      const targetPid = parseInt(match[1], 10);
      if (protectedPids.includes(targetPid)) {
        return { rewritten: command, modified: false, blocked: true, message: `cannot kill protected PID ${targetPid}` };
      }
    }
  }

  const winTaskkillIM = /taskkill\s+\/IM\s+(\S+)/i;
  if (winTaskkillIM.test(command)) {
    const match = command.match(winTaskkillIM);
    if (match) {
      const processName = match[1].replace(/\.exe$/i, '');
      const rewritten = `$__sc_protect=@(${protectedPidsStr}); Get-Process -Name '${processName}' | Where-Object { $__sc_protect -notcontains $_.Id } | ForEach-Object { taskkill /F /T /PID $_.Id }`;
      return { rewritten, modified: true, blocked: false, message: 'modified to protect host process' };
    }
  }

  const winTaskkillPID = /taskkill\s+\/PID\s+(\d+)/i;
  if (winTaskkillPID.test(command)) {
    const match = command.match(winTaskkillPID);
    if (match) {
      const targetPid = parseInt(match[1], 10);
      if (protectedPids.includes(targetPid)) {
        return { rewritten: command, modified: false, blocked: true, message: `cannot kill protected PID ${targetPid}` };
      }
    }
  }

  const unixKillAll = /killall\s+(\S+)/i;
  if (unixKillAll.test(command)) {
    const match = command.match(unixKillAll);
    if (match) {
      const processName = match[1];
      const rewritten = `for pid in $(pgrep '${processName}'); do if [ ! " ${protectedPidsStr} " =~ " \\$pid " ]; then kill -9 \\$pid; fi; done`;
      return { rewritten, modified: true, blocked: false, message: 'modified to protect host process' };
    }
  }

  const unixPkill = /pkill\s+(\S+)/i;
  if (unixPkill.test(command)) {
    const match = command.match(unixPkill);
    if (match) {
      const processName = match[1];
      const rewritten = `for pid in $(pgrep '${processName}'); do if [ ! " ${protectedPidsStr} " =~ " \\$pid " ]; then kill -9 \\$pid; fi; done`;
      return { rewritten, modified: true, blocked: false, message: 'modified to protect host process' };
    }
  }

  const unixKill = /kill\s+(-9\s+)?(\d+)/i;
  if (unixKill.test(command)) {
    const match = command.match(unixKill);
    if (match) {
      const targetPid = parseInt(match[2], 10);
      if (protectedPids.includes(targetPid)) {
        return { rewritten: command, modified: false, blocked: true, message: `cannot kill protected PID ${targetPid}` };
      }
    }
  }

  return { rewritten: command, modified: false, blocked: false };
}

function isGlobalElectronProcessNameCheck(command: string): boolean {
  const isKillCommand = /\b(Stop-Process|taskkill|killall|pkill|kill)\b/i.test(command);
  if (isKillCommand) return false;

  return (
    /Get-Process\s+-Name\s+(['"]?)electron\1\b/i.test(command) ||
    /\btasklist\b[\s\S]*\bfindstr\b[\s\S]*\belectron\b/i.test(command) ||
    /\bps\s+aux\b[\s\S]*\bgrep\b[\s\S]*\belectron\b/i.test(command)
  );
}

export function isForegroundElectronLaunch(command: string, runInBackground: boolean): boolean {
  if (runInBackground) return false;

  const commandStart = String.raw`(?:^|[;&|]\s*)`;
  const runner = String.raw`(?:(?:npx|bunx)\s+(?:--yes\s+)?|(?:npm|pnpm)\s+exec\s+|pnpm\s+dlx\s+|yarn\s+(?:exec\s+)?)?`;
  const electron = String.raw`electron(?:\.cmd|\.exe)?(?:\s|$)`;
  return new RegExp(commandStart + runner + electron, 'i').test(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readPackageJson(dir: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseNpmRun(command: string): { workspace?: string; script: string } | undefined {
  const match = command.match(
    /\b(?:npm|pnpm)\s+(?:(?:--workspace|-w)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s+)?run\s+([^\s;&|]+)/i,
  );
  if (!match) return undefined;

  return {
    workspace: match[1] ?? match[2] ?? match[3],
    script: match[4],
  };
}

function workspacePatterns(pkg: Record<string, unknown>): string[] {
  const workspaces = pkg.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry): entry is string => typeof entry === 'string');
  }
  if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
    return workspaces.packages.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

async function resolveWorkspacePackageDir(rootDir: string, workspace: string): Promise<string | undefined> {
  const rootPkg = await readPackageJson(rootDir);
  if (!rootPkg) return undefined;

  for (const pattern of workspacePatterns(rootPkg)) {
    if (pattern.includes('*')) continue;
    const candidateDir = resolve(rootDir, pattern);
    const candidatePkg = await readPackageJson(candidateDir);
    if (candidatePkg?.name === workspace) return candidateDir;
  }

  return undefined;
}

async function isForegroundElectronLaunchCommand(
  command: string,
  cwd: string,
  runInBackground: boolean,
): Promise<boolean> {
  if (isForegroundElectronLaunch(command, runInBackground)) return true;
  if (runInBackground) return false;

  const run = parseNpmRun(command);
  if (!run) return false;

  const commandRoot = resolveProjectEvidenceRoot(command, cwd);
  const packageDir = run.workspace
    ? await resolveWorkspacePackageDir(commandRoot, run.workspace)
    : commandRoot;
  if (!packageDir) return false;

  const pkg = await readPackageJson(packageDir);
  const scripts = isRecord(pkg?.scripts) ? pkg.scripts : undefined;
  const script = scripts?.[run.script];
  return typeof script === 'string' && isForegroundElectronLaunch(script, false);
}

function extractCdTarget(command: string): string | undefined {
  const match = command.match(/\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function resolveProjectEvidenceRoot(command: string, cwd: string): string {
  const cdTarget = extractCdTarget(command);
  return resolve(cwd, cdTarget || '.');
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildWindowsProjectProcessEvidenceCommand(
  projectRoot: string,
  launcherPid: number,
): string {
  const normalizedRoot = projectRoot.replace(/\\/g, '/');
  return [
    `$root = ${quotePowerShellSingle(normalizedRoot)}`,
    'Get-CimInstance Win32_Process |',
    `Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne ${launcherPid} -and (`,
    '(([string]$_.CommandLine).Replace(\'\\\', \'/\').IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or',
    '(([string]$_.ExecutablePath).Replace(\'\\\', \'/\').IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0)',
    ') } |',
    'Select-Object -First 1 ProcessId,Name,CommandLine,ExecutablePath |',
    'ConvertTo-Json -Compress',
  ].join(' ');
}

function parseProcessEvidenceOutput(output: string): ProcessEvidence | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as {
      ProcessId?: unknown;
      Name?: unknown;
      CommandLine?: unknown;
      ExecutablePath?: unknown;
    };
    if (typeof parsed.ProcessId !== 'number' || typeof parsed.Name !== 'string') {
      return undefined;
    }

    const source =
      typeof parsed.CommandLine === 'string' && parsed.CommandLine.trim()
        ? 'CommandLine'
        : 'ExecutablePath';
    return { pid: parsed.ProcessId, name: parsed.Name, source };
  } catch {
    return undefined;
  }
}

async function findProjectProcessEvidence(
  projectRoot: string,
  launcherPid: number,
): Promise<ProcessEvidence | undefined> {
  if (process.platform !== 'win32') return undefined;

  return new Promise((resolveEvidence) => {
    const child = spawn(
      getPowerShellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        buildWindowsProjectProcessEvidenceCommand(projectRoot, launcherPid),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 3000,
      },
    );

    let stdout = '';
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.on('close', () => resolveEvidence(parseProcessEvidenceOutput(stdout)));
    child.on('error', () => resolveEvidence(undefined));
  });
}

export function shouldWaitForServiceEvidenceAfterLauncherExit(args: {
  exitCode: number | null;
  hasReadinessTimeout: boolean;
  hasStartupMarker: boolean;
  evidenceFound: boolean;
}): boolean {
  return (
    args.exitCode === 0 &&
    args.hasReadinessTimeout &&
    !args.hasStartupMarker &&
    !args.evidenceFound
  );
}

function isCrossProjectSunCodeStartupMarker(
  command: string,
  startupMarker: string,
  cwd: string,
): boolean {
  if (!startupMarker.includes('[SunCode] STARTUP_COMPLETE')) return false;

  const cdTarget = extractCdTarget(command);
  if (!cdTarget) return false;

  return resolve(cwd, cdTarget).toLowerCase() !== cwd.toLowerCase();
}

function buildChildProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VITE_DEV_SERVER_URL;
  return env;
}

export function createBashTool(workingDir: string, callbacks?: BashToolCallbacks, options?: BashToolOptions) {
  const protectedPids = options?.protectedPids || [];

  return new (class BashTool extends BaseTool {
    readonly name = 'bash';
    readonly description = `Executes a shell command and returns its stdout and stderr. The working directory is the project root. Commands have a default timeout of 60 seconds.

IMPORTANT: Each invocation runs in a fresh shell. On Windows PowerShell, use ; to run commands sequentially, for example \`cd D:/project/app; npm run dev\`. On Linux/macOS bash, use && when later commands should only run after earlier commands succeed.

On Windows this runs Windows PowerShell (powershell.exe, always preinstalled). Windows PowerShell 5 does not support &&. It supports: ; for command sequencing, double quotes for strings with spaces, single quotes for literals, Select-String for searching files (instead of grep), Get-ChildItem for directory listing (instead of ls).

On Linux/macOS this runs bash.

Git examples that work cross-platform:
- \`git add . && git commit -m "feat(scope): message" && git push\`
- \`git status && git log --oneline -5\`

Set run_in_background: true for background processes. Background mode defaults to a finite task: when the shell exits, the UI marks it completed or failed. For long-running services/dev servers/GUI launchers, set background_mode: "service". For services with known startup output, set startup_marker and readiness_timeout so this tool waits for readiness before returning. For slow GUI launchers without a marker, set readiness_timeout so the tool waits before returning launch-only status. App readiness still requires a project-specific marker, reachable port, visible window, or process CommandLine/AppPath evidence.

Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file.

Security: Commands that are obviously destructive (rm -rf /, etc.) will be blocked.`;
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
          'Set to true to run this command in the background. By default, completion is tracked when the shell exits.',
        ),
        background_mode: p(
          'string',
          'Optional background behavior: "task" for finite background commands (default), or "service" for long-running dev servers/GUI launchers.',
        ),
        startup_marker: p(
          'string',
          'Optional text that indicates a background service is ready. When set with background_mode: "service", the tool waits for stdout/stderr to contain this marker before returning success.',
        ),
        readiness_timeout: p(
          'integer',
          'Optional readiness wait timeout in milliseconds when startup_marker is set (max 300000, default 120000).',
        ),
      },
      ['command'],
    );

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const command = (params.command as string) || '';
      const timeout = Math.min((params.timeout as number) || 60000, 300000);
      const cwd = resolve(workingDir);
      const inferredService = command
        ? await isForegroundElectronLaunchCommand(command, cwd, false)
        : false;
      const backgroundMode =
        params.background_mode === 'service' || inferredService ? 'service' : 'task';
      const runInBg = Boolean(params.run_in_background) || backgroundMode === 'service';
      const startupMarker =
        typeof params.startup_marker === 'string' && params.startup_marker.trim()
          ? params.startup_marker.trim()
          : '';
      const hasReadinessTimeout = typeof params.readiness_timeout === 'number';
      const readinessTimeout = Math.min(
        (params.readiness_timeout as number) || 120000,
        300000,
      );
      const serviceObservationMs = startupMarker
        ? readinessTimeout
        : Math.min(readinessTimeout, SERVICE_OBSERVATION_MS);
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

      if (isGlobalElectronProcessNameCheck(command)) {
        return commandFailure(
          'Global Electron process-name checks are not valid startup evidence. Use the exact background PID, a project-specific readiness marker, a reachable port, a visible window, or inspect process CommandLine/AppPath for the target project.',
        );
      }

      if (isCrossProjectSunCodeStartupMarker(command, startupMarker, cwd)) {
        return commandFailure(
          'SunCode startup marker cannot validate another project. Use the target project\'s own startup output, a reachable port, visible window evidence, or process CommandLine/AppPath evidence.',
        );
      }

      const killResult = rewriteKillCommand(command, protectedPids);
      if (killResult.blocked) {
        return commandFailure(`Command blocked for security reasons: ${killResult.message}`);
      }
      if (killResult.modified) {
        console.log(`[Bash] Rewrote kill command to protect host process: "${command}" → "${killResult.rewritten}"`);
      }
      const effectiveCommand = killResult.rewritten;

      const shell = process.platform === 'win32' ? getPowerShellPath() : '/bin/bash';
      const shellArgs =
        process.platform === 'win32'
          ? ['-NoProfile', '-NonInteractive', '-Command', effectiveCommand]
          : ['-c', effectiveCommand];

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
              env: buildChildProcessEnv(),
              stdio: 'pipe',
              detached: backgroundMode !== 'service',
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
          let combinedOutput = '';
          let resultSettled = false;
          let readinessTimer: ReturnType<typeof setTimeout> | null = null;
          let startupSettled = false;
          let startedPid: number | undefined;
          let completionNotified = false;

          const resolveOnce = (result: ToolResult) => {
            if (resultSettled) return;
            resultSettled = true;
            if (startedPid && result.success && result.pid === undefined) {
              result.pid = startedPid;
            }
            if (readinessTimer) {
              clearTimeout(readinessTimer);
              readinessTimer = null;
            }
            resolveResult(result);
          };

          const commandDetails = (exitCode: number | null = null) => ({
            type: 'command' as const,
            command,
            cwd,
            exitCode,
            stdout: combinedOutput,
            stderr: '',
          });

          const observedOutputSection = (): string => {
            const observed = truncateTail(combinedOutput, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES).text;
            return observed
              ? `\n\nObserved output during startup window:\n${observed}`
              : '\n\nObserved output during startup window:\n(no observed output yet)';
          };

          const resolveProcessEvidenceReady = async (): Promise<boolean> => {
            if (!startedPid || startupMarker) return false;
            const evidence = await findProjectProcessEvidence(
              resolveProjectEvidenceRoot(command, cwd),
              startedPid,
            );
            if (!evidence) return false;

              resolveOnce(
                this.success(
                `Background service ready (app PID: ${evidence.pid})\nCommand: ${command}\nMatched process ${evidence.source} evidence for project path: ${evidence.name}`,
                commandDetails(),
              ),
            );
            return true;
          };

          const resolveReady = () => {
            if (!startedPid || resultSettled) return;
              resolveOnce(
                this.success(
                `Background service ready (launcher PID: ${startedPid})\nCommand: ${command}\nMatched startup marker: ${startupMarker}`,
                commandDetails(),
              ),
            );
          };

          const flushProgress = () => {
            if (progressBuf && progress) {
              progress(progressBuf);
              progressBuf = '';
            }
            progressTimer = null;
          };

          const pushProgress = (text: string) => {
            combinedOutput += text;
            if (startupMarker && combinedOutput.includes(startupMarker)) {
              resolveReady();
            }
            if (!progress) return;
            progressBuf += text;
            if (!progressTimer) {
              progressTimer = setTimeout(flushProgress, 100);
            }
          };

          child.stdout?.on('data', (data: Buffer) => pushProgress(data.toString()));
          child.stderr?.on('data', (data: Buffer) => pushProgress(data.toString()));

          const failStartup = (message: string) => {
            if (resultSettled) return;
            startupSettled = true;
            resolveOnce(commandFailure(`Failed to start background process: ${message}`));
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

          child.on('close', async (code) => {
            if (!startupSettled) {
              // Exited before spawn event fired — startup failure
              failStartup(`process closed before startup (exit code: ${code ?? 'null'})`);
              notifyComplete(code ?? -1);
              return;
            }
            if (backgroundMode === 'service' && !resultSettled) {
              const evidenceFound = await resolveProcessEvidenceReady();
              if (evidenceFound) {
                if (progressTimer) {
                  clearTimeout(progressTimer);
                  flushProgress();
                }
                notifyComplete(code ?? -1);
                return;
              }

              if (startupMarker) {
                resolveOnce(
                  this.failure(
                    `Background service exited before startup marker was seen (exit code: ${code ?? 'null'}). Marker: ${startupMarker}`,
                    commandDetails(code ?? null),
                  ),
                );
              } else if (
                shouldWaitForServiceEvidenceAfterLauncherExit({
                  exitCode: code,
                  hasReadinessTimeout,
                  hasStartupMarker: Boolean(startupMarker),
                  evidenceFound,
                })
              ) {
                return;
              } else if (code === 0) {
                resolveOnce(
                  this.success(
                    `Background service launcher exited with code 0 (launcher PID: ${startedPid})\nCommand: ${command}\nThis does not confirm the app is ready. For GUI launchers this may mean the launcher handed off to the app process; verify with visible window or process CommandLine/AppPath evidence instead of starting it again.`,
                    commandDetails(0),
                  ),
                );
              } else {
                resolveOnce(
                  this.failure(
                    `Background service exited during readiness wait (exit code: ${code ?? 'null'}).`,
                    commandDetails(code ?? null),
                  ),
                );
              }
            }
            // Flush remaining progress before notifying completion
            if (progressTimer) {
              clearTimeout(progressTimer);
              flushProgress();
            }
            console.log(`[Bash] PID ${startedPid} exited with code ${code} - notifying completion`);
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
            if (backgroundMode !== 'service') {
              child.unref();
            }

            const proc: BackgroundProcess = {
              pid,
              command,
              startTime: Date.now(),
              status: 'running',
            };
            callbacks?.onBackgroundStart?.(proc);

            const output =
              backgroundMode === 'service'
                ? `Background service launch command started (launcher PID: ${pid})\nCommand: ${command}\nThis only confirms the launcher shell started; it does not confirm the app is ready. Do not treat the launcher PID as the app process; verify readiness with a project-specific marker, reachable port, or direct app evidence.`
                : `Background process started (PID: ${pid})\nCommand: ${command}`;

            if (backgroundMode === 'service') {
              readinessTimer = setTimeout(async () => {
                if (startupMarker) {
                  resolveOnce(
                    this.failure(
                      `Background service did not become ready within ${serviceObservationMs}ms. Marker not seen: ${startupMarker}`,
                      commandDetails(),
                    ),
                  );
                  return;
                }

                if (await resolveProcessEvidenceReady()) return;

                resolveOnce(
                  this.success(
                    `Background service still running after ${serviceObservationMs}ms observation (launcher PID: ${pid})\nCommand: ${command}\nThis does not confirm the app is ready. Do not treat the launcher PID as the app process; use the latest output, a startup_marker, reachable port, visible window, or process CommandLine/AppPath evidence for readiness.${observedOutputSection()}`,
                    commandDetails(),
                  ),
                );
              }, serviceObservationMs);
              return;
            }

            resolveOnce(
              this.success(output, {
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
          env: buildChildProcessEnv(),
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
            } catch (error) {
              console.warn(`[Bash] Failed to write full output to temp file:`, (error as Error).message);
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
