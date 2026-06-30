import type { CommandDetails, ToolResult } from '@shared/types';

export interface ModelToolResultContent {
  type: 'tool_result';
  tool: string;
  success: boolean;
  output: string;
  error?: string;
  log?: string;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  signal?: string;
  stdout?: string;
  stderr?: string;
  fullOutputPath?: string;
  expectedPorts?: number[];
  portsReachable?: number[];
  status?: 'command_completed' | 'command_failed' | 'service_observation';
  launcherPid?: number;
  appPid?: number;
}

export function formatToolResultForModel(result: ToolResult): string {
  const content: ModelToolResultContent = {
    type: 'tool_result',
    tool: result.name,
    success: result.success,
    output: result.output,
  };

  if (result.error) {
    content.error = result.error;
  }

  if (result.details?.type === 'command') {
    assignCommandDetails(content, result.details, result.pid);
  }

  const log = buildLogContent(result);
  if (log) {
    content.log = log;
  }

  return JSON.stringify(content, null, 2);
}

function assignCommandDetails(
  content: ModelToolResultContent,
  details: CommandDetails,
  pid: number | undefined,
): void {
  content.command = details.command;
  content.cwd = details.cwd;
  content.exitCode = details.exitCode;
  if (details.signal) content.signal = details.signal;
  if (details.stdout) content.stdout = details.stdout;
  if (details.stderr) content.stderr = details.stderr;
  if (details.fullOutputPath) content.fullOutputPath = details.fullOutputPath;
  if (details.expectedPorts) content.expectedPorts = details.expectedPorts;
  if (details.portsReachable) content.portsReachable = details.portsReachable;

  if (details.exitCode === null) {
    content.status = 'service_observation';
  } else {
    content.status = details.exitCode === 0 ? 'command_completed' : 'command_failed';
  }

  const launcherPid = extractPid('launcher PID', content.output) ?? pid;
  const appPid = extractPid('app PID', content.output);
  if (launcherPid !== undefined) content.launcherPid = launcherPid;
  if (appPid !== undefined) content.appPid = appPid;
}

function buildLogContent(result: ToolResult): string {
  const parts = [result.output];
  if (result.details?.type === 'command') {
    parts.push(result.details.stdout, result.details.stderr);
  }
  if (result.error) {
    parts.push(result.error);
  }
  return uniqueNonEmpty(parts).join('\n\n');
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function extractPid(label: string, text: string): number | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedLabel}\\s+(\\d+)`, 'i').exec(text);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isFinite(pid) ? pid : undefined;
}
