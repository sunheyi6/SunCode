import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSessionSnapshot,
  getAllMemories,
  loadMemories,
  loadSessionSnapshot,
  saveMemory,
  saveSessionSnapshot,
  type MemoryEntry,
} from '../../src/worker/agent/memory';

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

  it('loads project memories across sessions while keeping session memories scoped', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      await saveMemory(workingDir, {
        date: '2026-07-02',
        slug: 'project-port',
        scope: 'project',
        kind: 'project_fact',
        userRequest: 'dev server port',
        toolsUsed: {},
        summary: 'Dev server must use fixed port 5173.',
        importance: 4,
      });

      await saveMemory(
        workingDir,
        {
          date: '2026-07-02',
          slug: 'session-only',
          scope: 'session',
          kind: 'task_summary',
          userRequest: 'private session note',
          toolsUsed: {},
          summary: 'This temporary note belongs only to session-1.',
        },
        undefined,
        undefined,
        'session-1',
      );

      await expect(loadMemories(workingDir, '5173', 'session-2')).resolves.toContain(
        'fixed port 5173',
      );
      await expect(loadMemories(workingDir, 'temporary note', 'session-2')).resolves.not.toContain(
        'belongs only to session-1',
      );
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });

  it('prunes low-value memories before important pinned memories', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    await saveMemory(workingDir, {
      date: '2026-01-01',
      slug: 'pinned-architecture',
      scope: 'project',
      kind: 'decision',
      userRequest: 'architecture decision',
      toolsUsed: {},
      summary: 'Electron Main to Worker to AgentLoop is a one-way dependency.',
      importance: 5,
      pinned: true,
    });

    for (let i = 0; i < 35; i++) {
      await saveMemory(workingDir, {
        date: `2026-02-${String(i + 1).padStart(2, '0')}`,
        slug: `minor-${i}`,
        scope: 'project',
        kind: 'ephemeral',
        userRequest: `minor note ${i}`,
        toolsUsed: {},
        summary: `low value temporary memory ${i}`,
        importance: 0,
        expiresAt: '2026-03-01T00:00:00.000Z',
      });
    }

    const memories = getAllMemories(workingDir, undefined, 'project');
    expect(memories).toHaveLength(30);
    expect(memories.map((m) => m.slug)).toContain('pinned-architecture');
    expect(memories.some((m) => m.kind === 'ephemeral' && m.importance === 0)).toBe(true);
  });

  it('stores and restores a compact session snapshot for automatic sleep', () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      saveSessionSnapshot(workingDir, {
        sessionId: 'session-1',
        workingDir,
        status: 'paused',
        lastUserGoal: 'optimize memory system',
        summary: 'Design is approved and implementation is ready.',
        activeFiles: ['src/worker/agent/memory.ts'],
        pendingTasks: ['implement project memory'],
        updatedAt: '2026-07-05T10:00:00.000Z',
      });

      const snapshot = loadSessionSnapshot(workingDir, 'session-1');
      expect(snapshot).toMatchObject({
        sessionId: 'session-1',
        status: 'paused',
        lastUserGoal: 'optimize memory system',
        pendingTasks: ['implement project memory'],
      });
      expect(existsSync(join(appDataDir, 'sessions', 'session-1', 'snapshot.json'))).toBe(true);
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });

  it('builds a compact sleep snapshot from recent conversation messages', () => {
    const snapshot = buildSessionSnapshot({
      sessionId: 'session-1',
      workingDir: 'D:/project/SunCode',
      status: 'completed',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'optimize memory system' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Implemented project memory and snapshot support.' }],
          toolCalls: [
            {
              type: 'tool_call',
              id: 'tc1',
              name: 'edit',
              arguments: JSON.stringify({ path: 'src/worker/agent/memory.ts' }),
            },
          ],
        },
      ],
    });

    expect(snapshot).toMatchObject({
      sessionId: 'session-1',
      status: 'completed',
      lastUserGoal: 'optimize memory system',
      summary: 'Implemented project memory and snapshot support.',
      activeFiles: ['src/worker/agent/memory.ts'],
    });
    expect(snapshot.updatedAt).toBeTruthy();
  });
});
