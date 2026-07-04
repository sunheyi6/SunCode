import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createWorktreeForSession,
  isGitRepo,
  isInsideWorktree,
  removeWorktreeForSession,
  validateWorktreePath,
} from '../../src/main/git-worktree';

/**
 * Create a temporary Git repository with an initial commit.
 * Returns the repo path.
 */
function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-test-'));
  execSync('git init', { cwd: dir, stdio: 'pipe', windowsHide: true });
  execSync('git config user.email test@test', { cwd: dir, stdio: 'pipe', windowsHide: true });
  execSync('git config user.name test', { cwd: dir, stdio: 'pipe', windowsHide: true });
  // Create an initial commit so we have a branch to work from
  writeFileSync(join(dir, 'README.md'), '# test', 'utf-8');
  execSync('git add -A', { cwd: dir, stdio: 'pipe', windowsHide: true });
  execSync('git commit -m init', { cwd: dir, stdio: 'pipe', windowsHide: true });
  return dir;
}

describe('isGitRepo', () => {
  it('返回 true 当目录是 Git 仓库', () => {
    const repo = initTempRepo();
    try {
      expect(isGitRepo(repo)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('返回 false 当目录不是 Git 仓库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'non-git-'));
    try {
      expect(isGitRepo(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isInsideWorktree', () => {
  it('返回 false 在主仓库中', () => {
    const repo = initTempRepo();
    try {
      expect(isInsideWorktree(repo)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('返回 true 在 linked worktree 中', () => {
    const repo = initTempRepo();
    try {
      const wt = join(repo, '..', 'wt-child');
      // Use HEAD instead of a branch name — the default branch name varies
      // across Git versions and platforms.
      execSync(`git worktree add ${wt} HEAD`, { cwd: repo, stdio: 'pipe', windowsHide: true });
      try {
        expect(isInsideWorktree(wt)).toBe(true);
      } finally {
        execSync(`git worktree remove --force ${wt}`, {
          cwd: repo,
          stdio: 'pipe',
          windowsHide: true,
        });
        rmSync(wt, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('返回 false 在非 git 目录中（无异常崩溃）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'non-git-'));
    try {
      expect(isInsideWorktree(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createWorktreeForSession', () => {
  it('在 Git 仓库中创建 worktree 并返回正确字段', () => {
    const repo = initTempRepo();
    try {
      const sessionId = `session_1234567890_abcdef`;
      const result = createWorktreeForSession(repo, sessionId);

      expect(result).not.toBeNull();
      const r = result!;
      // branch = suncode/session_<sessionId.slice(-8)>
      // sessionId "session_1234567890_abcdef" → slice(-8) → "0_abcdef"
      expect(r.branch).toBe('suncode/session_0_abcdef');
      expect(r.mainRepoPath).toBe(repo);

      // Worktree path should be a sibling directory
      // sessionId.slice(-8) → "0_abcdef"
      const expectedPath = join(repo, '..', `${repo.split(/[/\\]/).pop()}-wt-0_abcdef`);
      expect(r.worktreePath).toBe(expectedPath);

      // The worktree directory should actually exist and be a git repo
      expect(isGitRepo(r.worktreePath)).toBe(true);

      // Cleanup
      removeWorktreeForSession(repo, r.branch, r.worktreePath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('返回 null 如果 worktree 路径已存在', () => {
    const repo = initTempRepo();
    try {
      const sessionId = `session_1234567890_dupdup`;
      const first = createWorktreeForSession(repo, sessionId);
      expect(first).not.toBeNull();

      // Second call with same sessionId → same branch → git worktree add fails
      const second = createWorktreeForSession(repo, sessionId);
      expect(second).toBeNull();

      // Cleanup
      if (first) {
        removeWorktreeForSession(repo, first.branch, first.worktreePath);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('返回 null 如果目录不是 Git 仓库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'non-git-'));
    try {
      const result = createWorktreeForSession(dir, 'session_test');
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('removeWorktreeForSession', () => {
  it('删除 worktree 目录和分支', () => {
    const repo = initTempRepo();
    try {
      const sessionId = `session_1234567890_remove`;
      const created = createWorktreeForSession(repo, sessionId);
      expect(created).not.toBeNull();
      const wtPath = created!.worktreePath;

      expect(existsSync(wtPath)).toBe(true);

      const result = removeWorktreeForSession(repo, created!.branch, wtPath);
      expect(result.success).toBe(true);

      // Worktree directory should be gone or pruned (git worktree remove
      // may leave an empty skeleton on some platforms).
      expect(existsSync(wtPath)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('静默处理已不存在的 worktree', () => {
    const repo = initTempRepo();
    try {
      const result = removeWorktreeForSession(repo, 'suncode/session_ghost');
      expect(result.success).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('validateWorktreePath', () => {
  it('返回 worktree 路径当目录存在', () => {
    const repo = initTempRepo();
    try {
      const sessionId = `session_1234567890_valid`;
      const created = createWorktreeForSession(repo, sessionId);
      expect(created).not.toBeNull();
      const { worktreePath, mainRepoPath } = created!;

      const result = validateWorktreePath(worktreePath, mainRepoPath);
      expect(result.workingDirectory).toBe(worktreePath);
      expect(result.isValid).toBe(true);

      // Cleanup
      removeWorktreeForSession(repo, created!.branch, worktreePath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('回退到主仓库路径当 worktree 目录不存在', () => {
    const repo = initTempRepo();
    try {
      const fakeWt = join(repo, '..', 'nonexistent-worktree');
      const result = validateWorktreePath(fakeWt, repo);
      expect(result.workingDirectory).toBe(repo);
      expect(result.isValid).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('返回主仓库路径当 gitWorktreePath 为 undefined', () => {
    const result = validateWorktreePath(undefined, '/some/repo');
    expect(result.workingDirectory).toBe('/some/repo');
    expect(result.isValid).toBe(true);
  });

  it('返回空字符串当两个参数都为 undefined', () => {
    const result = validateWorktreePath(undefined, undefined);
    expect(result.workingDirectory).toBe('');
    expect(result.isValid).toBe(true);
  });
});
