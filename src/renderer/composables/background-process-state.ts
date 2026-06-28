import type { BackgroundProcess } from '@shared/types';

export function upsertStartedProcess(
  processes: BackgroundProcess[],
  process: BackgroundProcess,
): void {
  const index = processes.findIndex((item) => item.pid === process.pid);
  if (index >= 0) processes[index] = { ...process, status: 'running' };
  else processes.push({ ...process, status: 'running' });
}

export function completeProcess(
  processes: BackgroundProcess[],
  pid: number,
  exitCode: number,
  endTime = Date.now(),
): void {
  const process = processes.find((item) => item.pid === pid);
  if (!process) return;
  process.status = exitCode === 0 ? 'completed' : 'error';
  process.exitCode = exitCode;
  process.endTime = endTime;
}

export function latestProcess(processes: BackgroundProcess[]): BackgroundProcess | undefined {
  return processes.reduce<BackgroundProcess | undefined>(
    (latest, process) => (!latest || process.startTime > latest.startTime ? process : latest),
    undefined,
  );
}

export function markProcessKilled(
  processes: BackgroundProcess[],
  pid: number,
): void {
  const process = processes.find((item) => item.pid === pid);
  if (!process) return;
  process.killed = true;
  process.endTime = Date.now();
}

/** Remove a process from the array by PID (called after OS confirms kill) */
export function removeProcess(
  processes: BackgroundProcess[],
  pid: number,
): void {
  const index = processes.findIndex((item) => item.pid === pid);
  if (index >= 0) processes.splice(index, 1);
}

/** Update a process's portsReachable after background port verification. */
export function updateProcessPorts(
  processes: BackgroundProcess[],
  pid: number,
  ports: number[],
): void {
  const process = processes.find((item) => item.pid === pid);
  if (!process) return;
  process.portsReachable = ports;
}

export function formatElapsedTime(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}小时 ${Math.floor((seconds % 3600) / 60)}分`;
}
