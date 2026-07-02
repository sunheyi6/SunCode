import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMemories, saveMemory, type MemoryEntry } from '../../src/worker/agent/memory';

let tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('memory storage', () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('stores session memories under app data instead of the workspace', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      const entry: MemoryEntry = {
        date: '2026-07-02',
        slug: 'session-summary',
        userRequest: '记住这次会话',
        toolsUsed: { read: 1 },
        summary: '会话摘要',
      };

      await saveMemory(workingDir, entry, undefined, undefined, 'session-1');

      expect(existsSync(join(appDataDir, 'sessions', 'session-1', 'memories', '2026-07-02-session-summary.md'))).toBe(
        true,
      );
      expect(existsSync(join(workingDir, '.suncode'))).toBe(false);
      await expect(loadMemories(workingDir, '会话', 'session-1')).resolves.toContain('记住这次会话');
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });
});
