import type { CommandDetails, FileEditDetails, ToolResult } from '@shared/types';

export type ModelToolResultKind = 'text' | 'command' | 'file_edit' | 'subagent' | 'error';

export interface ModelToolResultContent {
  type: 'tool_result';
  tool: string;
  success: boolean;
  /** Semantic payload kind for model/budget consumers. */
  kind: ModelToolResultKind;
  /** Primary model-facing body. Avoid duplicating the same text in other fields. */
  output: string;
  error?: string;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  signal?: string;
  /** Included only when not already fully present in `output`. */
  stdout?: string;
  /** Included only when not already fully present in `output`. */
  stderr?: string;
  fullOutputPath?: string;
  expectedPorts?: number[];
  portsReachable?: number[];
  status?: 'command_completed' | 'command_failed' | 'service_observation';
  launcherPid?: number;
  appPid?: number;
  filePath?: string;
  editStatus?: FileEditDetails['status'];
  addedLines?: number;
  removedLines?: number;
  /** True when body was truncated at execution time or a full dump was spilled. */
  truncated?: boolean;
  kept?: 'head' | 'tail' | 'middle';
  /** How the model can recover omitted content. */
  recoveryHint?: string;
}

export function formatToolResultForModel(result: ToolResult): string {
  const kind = resolveKind(result);
  const content: ModelToolResultContent = {
    type: 'tool_result',
    tool: result.name,
    success: result.success,
    kind,
    output: result.output,
  };

  if (result.error) {
    content.error = result.error;
  }

  if (result.details?.type === 'command') {
    assignCommandDetails(content, result.details, result.pid);
  } else if (result.details?.type === 'file_edit') {
    assignFileEditDetails(content, result.details);
  } else if (kind === 'subagent') {
    // Keep output as the primary summary; subagent details stay on ToolResult for UI.
  }

  assignTruncationMeta(content, result.details?.type === 'command' ? result.details : undefined);

  return JSON.stringify(content, null, 2);
}

function resolveKind(result: ToolResult): ModelToolResultKind {
  if (!result.success && result.error && !result.details) return 'error';
  if (result.details?.type === 'command') return 'command';
  if (result.details?.type === 'file_edit') return 'file_edit';
  if (result.subagentResults && result.subagentResults.length > 0) return 'subagent';
  if (!result.success && result.error) return 'error';
  return 'text';
}

function assignCommandDetails(
  content: ModelToolResultContent,
  details: CommandDetails,
  pid: number | undefined,
): void {
  content.kind = 'command';
  content.command = details.command;
  content.cwd = details.cwd;
  content.exitCode = details.exitCode;
  if (details.signal) content.signal = details.signal;
  if (details.fullOutputPath) content.fullOutputPath = details.fullOutputPath;
  if (details.expectedPorts) content.expectedPorts = details.expectedPorts;
  if (details.portsReachable) content.portsReachable = details.portsReachable;

  // Only attach stdout/stderr when they add facts not already in the primary body.
  // Bash packs them into `output`; service observations may keep a short output
  // while stdout holds the useful startup log.
  const stdout = nonEmptyExtra(details.stdout, content.output);
  if (stdout) content.stdout = stdout;
  const stderr = nonEmptyExtra(details.stderr, content.output);
  if (stderr) content.stderr = stderr;

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

function assignFileEditDetails(content: ModelToolResultContent, details: FileEditDetails): void {
  content.kind = 'file_edit';
  content.filePath = details.filePath;
  content.editStatus = details.status;
  if (details.addedLines !== undefined) content.addedLines = details.addedLines;
  if (details.removedLines !== undefined) content.removedLines = details.removedLines;
  if (details.error && !content.error) content.error = details.error;
}

function assignTruncationMeta(
  content: ModelToolResultContent,
  details: CommandDetails | undefined,
): void {
  const output = content.output ?? '';
  const hasFullPath = Boolean(details?.fullOutputPath || content.fullOutputPath);
  const hasSkipMarker = output.includes('earlier lines skipped');
  const hasFullSavedMarker = output.includes('Full output saved to:');

  if (!hasFullPath && !hasSkipMarker && !hasFullSavedMarker) return;

  content.truncated = true;
  content.kept = 'tail';

  const path = content.fullOutputPath ?? details?.fullOutputPath;
  if (path) {
    content.fullOutputPath = path;
    content.recoveryHint =
      `Full output saved at ${path}. Use the read tool on that path if you need omitted portions. ` +
      'If re-running the command could repeat side effects, do not re-run it.';
  } else {
    content.recoveryHint =
      'Output was truncated to a tail window. Re-run only if safe, redirecting to a file, then read that file.';
  }
}

/** Return trimmed text only when it is non-empty and not already fully present in body. */
function nonEmptyExtra(text: string | undefined, body: string): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (body.includes(trimmed)) return undefined;
  return text;
}

function extractPid(label: string, text: string): number | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedLabel}\\s+(\\d+)`, 'i').exec(text);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isFinite(pid) ? pid : undefined;
}
