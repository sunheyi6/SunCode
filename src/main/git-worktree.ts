import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function git(workingDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: workingDir,
    encoding: 'utf-8',
    windowsHide: true,
  }).trim();
}

export interface WorktreeCreationResult {
  worktreePath: string;
  branch: string;
  mainRepoPath: string;
}

/**
 * Create a Git worktree for a new session.
 *
 * Creates a branch `suncode/session_<shortId>` from the current HEAD,
 * then adds a Git worktree in a sibling directory named
 * `<repoDirName>-wt-<shortId>/`.
 *
 * Returns `null` if the directory is not a Git repository or if worktree
 * creation fails (e.g. the branch or worktree path already exists).
 */
export function createWorktreeForSession(
  repoPath: string,
  sessionId: string,
): WorktreeCreationResult | null {
  // Verify this is a Git repository
  try {
    git(repoPath, ['rev-parse', '--git-dir']);
  } catch {
    return null;
  }

  const shortId = sessionId.slice(-8);
  const branch = `suncode/session_${shortId}`;
  const parentDir = dirname(repoPath);
  const repoName = basename(repoPath);
  const worktreePath = join(parentDir, `${repoName}-wt-${shortId}`);

  // Check whether the worktree path already exists
  if (existsSync(worktreePath)) {
    console.warn(`[GitWorktree] Worktree path already exists: ${worktreePath}`);
    return null;
  }

  try {
    // Create a branch from the current HEAD
    git(repoPath, ['branch', branch, 'HEAD']);

    // Add the worktree
    git(repoPath, ['worktree', 'add', worktreePath, branch]);

    console.log(
      `[GitWorktree] Created worktree: branch=${branch} path=${worktreePath} repo=${repoPath}`,
    );

    return { worktreePath, branch, mainRepoPath: repoPath };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    console.error('[GitWorktree] Failed to create worktree:', err.stderr || err.message);

    // Best-effort cleanup: remove the branch if creation failed halfway
    try {
      git(repoPath, ['branch', '-D', branch]);
    } catch {
      // Ignore cleanup errors
    }

    return null;
  }
}

/**
 * Look up the worktree path for a given branch via `git worktree list`.
 */
export function getWorktreePath(mainRepoPath: string, branch: string): string | null {
  try {
    const output = git(mainRepoPath, ['worktree', 'list', '--porcelain']);
    const lines = output.split('\n');
    let currentPath = '';
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length).trim();
      } else if (line === `branch refs/heads/${branch}`) {
        return currentPath;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove a Git worktree and its associated branch.
 *
 * Uses `worktreePath` (recommended) if provided, otherwise looks up
 * the worktree path from the branch name via `git worktree list`.
 */
export function removeWorktreeForSession(
  mainRepoPath: string,
  branch: string,
  worktreePath?: string,
): { success: boolean; error?: string } {
  try {
    const wtPath = worktreePath || getWorktreePath(mainRepoPath, branch);
    if (!wtPath) {
      // Branch might already be removed; clean up the branch just in case
      try {
        git(mainRepoPath, ['branch', '-D', branch]);
      } catch {
        // Ignore — branch may not exist
      }
      return { success: true };
    }

    // Remove the worktree (force-unlock if locked, prune if dangling)
    try {
      git(mainRepoPath, ['worktree', 'remove', '--force', wtPath]);
    } catch {
      // Fallback: prune dangling worktree references
      git(mainRepoPath, ['worktree', 'prune']);
    }
    // Remove the branch
    try {
      git(mainRepoPath, ['branch', '-D', branch]);
    } catch {
      // Branch may already be gone
    }
    console.log(`[GitWorktree] Removed worktree: branch=${branch} repo=${mainRepoPath}`);
    return { success: true };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const message = err.stderr?.trim() || err.message || 'Failed to remove worktree';
    console.error('[GitWorktree] Failed to remove worktree:', message);
    return { success: false, error: message };
  }
}

/**
 * Check whether a directory is inside a Git repository.
 */
export function isGitRepo(dir: string): boolean {
  try {
    git(dir, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a directory is inside a **linked** Git worktree (as opposed
 * to the main working tree).
 *
 * A linked worktree has a `.git` *file* pointing to the main repo, whereas
 * the main working tree has a `.git` *directory*.  We detect this by checking
 * whether `git rev-parse --git-dir` contains `/worktrees/` in its path.
 */
export function isInsideWorktree(dir: string): boolean {
  try {
    const gitDir = git(dir, ['rev-parse', '--git-dir']);
    // In a linked worktree, --git-dir returns a path like
    //   /path/to/main/.git/worktrees/<name>
    // In the main working tree it returns just `.git` or an absolute path
    // without `/worktrees/`.
    return gitDir.includes('/worktrees/') || gitDir.includes('\\worktrees\\');
  } catch {
    return false;
  }
}

/**
 * Validate that a session's Git worktree still exists on disk.
 *
 * If the worktree directory has been removed externally, this logs a warning
 * and returns the main repo path as a fallback so the session can still
 * function without pointing at a dangling directory.
 */
export function validateWorktreePath(
  gitWorktreePath: string | undefined,
  gitMainRepoPath: string | undefined,
): { workingDirectory: string; isValid: boolean } {
  if (!gitWorktreePath || !gitMainRepoPath) {
    return { workingDirectory: gitMainRepoPath || '', isValid: true };
  }
  if (existsSync(gitWorktreePath)) {
    return { workingDirectory: gitWorktreePath, isValid: true };
  }
  console.warn(`[GitWorktree] Worktree path gone, falling back to main repo: ${gitWorktreePath}`);
  return { workingDirectory: gitMainRepoPath, isValid: false };
}
