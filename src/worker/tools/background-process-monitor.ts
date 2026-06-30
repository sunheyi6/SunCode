import type { BackgroundProcess } from '@shared/types';

export interface MonitoredProcess {
  sessionId: string;
  process: BackgroundProcess;
}

export type ProcessExitCallback = (item: MonitoredProcess, exitCode: number) => void;
export type ProcessAliveCheck = (pid: number) => boolean;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function processMonitorPid(process: BackgroundProcess): number {
  return process.monitorPid ?? process.pid;
}

export class BackgroundProcessMonitor {
  private readonly processes = new Map<string, MonitoredProcess>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly onExit: ProcessExitCallback,
    private readonly isAlive: ProcessAliveCheck = isProcessAlive,
    private readonly intervalMs = 2000,
  ) {}

  register(sessionId: string, process: BackgroundProcess): void {
    this.processes.set(String(process.pid), { sessionId, process });
    this.ensureTimer();
  }

  unregister(pid: number): void {
    this.processes.delete(String(pid));
    this.stopTimerIfIdle();
  }

  getMonitorPid(pid: number): number | undefined {
    const process = this.processes.get(String(pid))?.process;
    return process ? processMonitorPid(process) : undefined;
  }

  checkOnce(): void {
    for (const [pid, item] of [...this.processes.entries()]) {
      if (this.isAlive(processMonitorPid(item.process))) continue;
      this.processes.delete(pid);
      this.onExit(item, -1);
    }
    this.stopTimerIfIdle();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkOnce(), this.intervalMs);
  }

  private stopTimerIfIdle(): void {
    if (this.processes.size > 0 || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
