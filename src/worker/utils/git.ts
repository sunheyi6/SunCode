import { execSync } from 'node:child_process';

/**
 * Git utilities for the agent.
 * Provides basic git information about the working directory.
 */

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  remoteUrl?: string;
  lastCommit?: {
    hash: string;
    message: string;
    author: string;
    date: string;
  };
  status?: GitStatus;
}

export interface GitStatus {
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
}

/**
 * Detect if a directory is a git repository and gather info.
 */
export function getGitInfo(workingDir: string): GitInfo {
  try {
    // Check if it's a git repo
    try {
      execSync('git rev-parse --git-dir', { cwd: workingDir, stdio: 'ignore' });
    } catch {
      return { isRepo: false };
    }

    // Get branch
    let branch = 'unknown';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: workingDir,
        encoding: 'utf-8',
      }).trim();
    } catch {
      // HEAD might be detached
    }

    // Get remote URL
    let remoteUrl: string | undefined;
    try {
      remoteUrl = execSync('git config --get remote.origin.url', {
        cwd: workingDir,
        encoding: 'utf-8',
      }).trim();
    } catch {
      // No remote configured
    }

    // Get last commit
    let lastCommit: GitInfo['lastCommit'] | undefined;
    try {
      const hash = execSync('git log -1 --format=%H', {
        cwd: workingDir,
        encoding: 'utf-8',
      }).trim();
      const message = execSync('git log -1 --format=%s', {
        cwd: workingDir,
        encoding: 'utf-8',
      }).trim();
      const author = execSync('git log -1 --format=%an', {
        cwd: workingDir,
        encoding: 'utf-8',
      }).trim();
      const date = execSync('git log -1 --format=%ci', {
        cwd: workingDir,
        encoding: 'utf-8',
      }).trim();
      lastCommit = { hash, message, author, date };
    } catch {
      // No commits yet
    }

    // Get status
    let status: GitStatus | undefined;
    try {
      const statusOutput = execSync('git status --porcelain', {
        cwd: workingDir,
        encoding: 'utf-8',
      });
      status = {
        modified: [],
        added: [],
        deleted: [],
        untracked: [],
      };
      for (const line of statusOutput.split('\n').filter(Boolean)) {
        const code = line.slice(0, 2);
        const file = line.slice(3);
        if (code.includes('M')) status.modified.push(file);
        if (code.includes('A')) status.added.push(file);
        if (code.includes('D')) status.deleted.push(file);
        if (code.includes('??')) status.untracked.push(file);
      }
    } catch {
      // Status not available
    }

    return {
      isRepo: true,
      branch,
      remoteUrl,
      lastCommit,
      status,
    };
  } catch {
    return { isRepo: false };
  }
}

/**
 * Get a summary of git information for display.
 */
export function getGitSummary(workingDir: string): string {
  const info = getGitInfo(workingDir);
  if (!info.isRepo) return 'Not a git repository';

  const parts: string[] = [];
  if (info.branch) parts.push(`Branch: ${info.branch}`);
  if (info.status) {
    const changes =
      info.status.modified.length + info.status.added.length + info.status.deleted.length;
    if (changes > 0) parts.push(`${changes} changed file(s)`);
    if (info.status.untracked.length > 0)
      parts.push(`${info.status.untracked.length} untracked file(s)`);
  }
  return parts.join(' | ');
}
