import { execFileSync } from 'node:child_process';
import type { GitInfo } from '@shared/types';

export interface GitLineStats {
  addedLines: number;
  deletedLines: number;
  changedFiles: number;
}

export function parseNumstat(output: string): GitLineStats {
  let addedLines = 0;
  let deletedLines = 0;
  let changedFiles = 0;

  for (const line of output.trim().split('\n')) {
    if (!line) continue;
    const [added, deleted] = line.split('\t');
    changedFiles += 1;
    if (added !== '-') addedLines += Number.parseInt(added, 10) || 0;
    if (deleted !== '-') deletedLines += Number.parseInt(deleted, 10) || 0;
  }

  return { addedLines, deletedLines, changedFiles };
}

function git(workingDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: workingDir,
    encoding: 'utf-8',
    windowsHide: true,
  }).trim();
}

export function getGitInfo(workingDir: string): GitInfo {
  try {
    git(workingDir, ['rev-parse', '--git-dir']);
  } catch {
    return {
      isRepo: false,
      addedLines: 0,
      deletedLines: 0,
      changedFiles: 0,
      stagedFiles: 0,
    };
  }

  let branch: string | undefined;
  let remoteUrl: string | undefined;
  try {
    branch = git(workingDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {}
  try {
    remoteUrl = git(workingDir, ['remote', 'get-url', 'origin']);
  } catch {}

  let lineStats: GitLineStats = { addedLines: 0, deletedLines: 0, changedFiles: 0 };
  try {
    lineStats = parseNumstat(git(workingDir, ['diff', '--numstat', 'HEAD']));
  } catch {}

  let stagedFiles = 0;
  try {
    const staged = git(workingDir, ['diff', '--cached', '--name-only']);
    stagedFiles = staged ? staged.split(/\r?\n/).filter(Boolean).length : 0;
  } catch {}

  return { isRepo: true, branch, remoteUrl, ...lineStats, stagedFiles };
}
