/**
 * Diagnostic logger for the agent loop.
 *
 * Writes structured, timestamped diagnostic logs to a file AND (in dev mode) to console.log.
 * File goes to .suncode/diagnostics/<runId>.log in the working directory.
 * Each run gets its own file — old logs are never overwritten.
 *
 * Log format:
 *   [T+1234ms] [CATEGORY] key=value key2=value2 | free text
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { threadId } from 'node:worker_threads';
import { readRuntimeIdentityEnvironment } from '@shared/runtime-identity';

const IS_DEV = process.env.SUNCODE_IS_DEV === '1';

export class DiagLogger {
  private logPath: string;
  private runStart: number;

  constructor(workingDir: string, runId: string) {
    const baseDir = process.env.SUNCODE_APP_DATA || resolve(workingDir, '.suncode');
    this.logPath = resolve(baseDir, 'diagnostics', `${runId}.log`);
    this.runStart = Date.now();
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
    } catch {
      // Best-effort: don't crash if we can't create the directory
    }
    const runtime = readRuntimeIdentityEnvironment(process.env, threadId);
    if (runtime) {
      this.log('INSTANCE', 'runtime identity', { ...runtime });
    }
  }

  /** Absolute time since run started, e.g. "T+1234ms" */
  private elapsed(): string {
    return `T+${Date.now() - this.runStart}ms`;
  }

  /** Write a structured log entry. Automatically prepends timestamp. */
  log(category: string, message: string, data?: Record<string, unknown>): void {
    const dataStr = data
      ? ` | ${Object.entries(data)
          .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
          .join(' ')}`
      : '';
    const line = `[${this.elapsed()}] [${category}] ${message}${dataStr}`;

    if (IS_DEV) {
      console.log(`[Diag] ${line}`);
    }

    try {
      appendFileSync(this.logPath, `${line}\n`, 'utf-8');
    } catch {
      // Never let logging break the agent
    }
  }

  /** Log a start/entry event. */
  enter(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(category, `>>> ${message}`, data);
  }

  /** Log a completion/exit event. */
  exit(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(category, `<<< ${message}`, data);
  }

  /** Log a milestone event (decisions, errors, transitions). */
  milestone(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(category, `● ${message}`, data);
  }

  getPath(): string {
    return this.logPath;
  }
}
