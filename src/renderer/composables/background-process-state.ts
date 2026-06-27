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
  process.status = 'error';
  process.exitCode = -1;
  process.endTime = Date.now();
}

export function formatElapsedTime(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}小时 ${Math.floor((seconds % 3600) / 60)}分`;
}
