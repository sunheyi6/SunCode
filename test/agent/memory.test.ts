import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSessionSnapshot,
  deleteMemory,
  flushMemoryAccessCounts,
  getAllMemories,
  getMemScenes,
  isMemoryWorthSaving,
  loadMemories,
  loadMemoriesWithEntries,
  migrateLegacyFlatMemories,
  migrateLegacyProjectMemories,
  loadSessionSnapshot,
  mergeMemories,
  saveMemory,
  saveSessionSnapshot,
  updateMemory,
  type MemoryEntry,
  type RelevanceCandidate,
  type StructuredFact,
} from '../../src/worker/agent/memory';
import { promoteExplicitDurableFacts } from '../../src/worker/agent/agent';

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

  it('returns project and active session memories for the memory manager', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    await saveMemory(workingDir, {
      date: '2026-07-11',
      slug: 'project-memory',
      scope: 'project',
      userRequest: '项目记忆',
      toolsUsed: {},
      summary: '项目级自动记忆',
    });
    await saveMemory(
      workingDir,
      {
        date: '2026-07-11',
        slug: 'session-memory',
        scope: 'session',
        userRequest: '会话记忆',
        toolsUsed: { read: 1 },
        summary: '自动生成的会话记忆',
      },
      undefined,
      undefined,
      'session-1',
    );

    const memories = getAllMemories(workingDir, 'session-1');
    expect(memories.map((entry) => entry.slug)).toEqual(
      expect.arrayContaining(['project-memory', 'session-memory']),
    );
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

  it('supports structured facts extraction', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    const facts: StructuredFact[] = [
      {
        type: 'preference',
        subject: '用户',
        predicate: '喜欢',
        object: 'TypeScript',
        validity: { start: '2026-07-11' },
        confidence: 0.9,
      },
      {
        type: 'fact',
        subject: '项目',
        predicate: '使用',
        object: 'Vue 3',
        validity: { start: '2026-07-11' },
        confidence: 1.0,
      },
    ];

    await saveMemory(workingDir, {
      date: '2026-07-11',
      slug: 'user-preferences',
      scope: 'project',
      kind: 'preference',
      userRequest: '我喜欢用 TypeScript 开发，项目使用 Vue 3',
      toolsUsed: {},
      summary: '用户偏好 TypeScript 和 Vue 3',
      facts,
    });

    const memories = getAllMemories(workingDir, undefined, 'project');
    expect(memories.length).toBeGreaterThan(0);
    const entry = memories.find((m) => m.slug === 'user-preferences');
    expect(entry).toBeDefined();
    expect(entry?.facts).toEqual(facts);
  });

  it('round-trips the memory origin through storage', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      await saveMemory(
        workingDir,
        {
          date: '2026-07-11',
          slug: 'auto-entry',
          scope: 'session',
          userRequest: 'auto session memory',
          toolsUsed: { read: 1 },
          summary: 'auto saved summary',
          origin: 'auto',
        },
        undefined,
        undefined,
        'session-1',
      );
      await saveMemory(workingDir, {
        date: '2026-07-11',
        slug: 'explicit-entry',
        scope: 'global',
        kind: 'preference',
        userRequest: 'remember I like TypeScript',
        toolsUsed: {},
        summary: 'explicit durable preference',
        origin: 'explicit',
      });
      await saveMemory(workingDir, {
        date: '2026-07-11',
        slug: 'manual-entry',
        scope: 'project',
        kind: 'decision',
        userRequest: 'manually added decision',
        toolsUsed: {},
        summary: 'manual entry',
        origin: 'manual',
      });

      const all = getAllMemories(workingDir, 'session-1');
      expect(all.find((m) => m.slug === 'auto-entry')?.origin).toBe('auto');
      expect(all.find((m) => m.slug === 'explicit-entry')?.origin).toBe('explicit');
      expect(all.find((m) => m.slug === 'manual-entry')?.origin).toBe('manual');
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });
  it('updates and deletes project memories without a session id', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    await saveMemory(workingDir, {
      date: '2026-07-11',
      slug: 'project-note',
      scope: 'project',
      userRequest: '项目使用 Bun',
      toolsUsed: {},
      summary: '初始摘要',
    });

    updateMemory(workingDir, '2026-07-11', 'project-note', { summary: '更新后的摘要' });
    expect(getAllMemories(workingDir).find((entry) => entry.slug === 'project-note')?.summary).toBe(
      '更新后的摘要',
    );

    deleteMemory(workingDir, '2026-07-11', 'project-note');
    expect(getAllMemories(workingDir).find((entry) => entry.slug === 'project-note')).toBeUndefined();
  });

  it('moves a memory when its scope is updated', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    await saveMemory(
      workingDir,
      {
        date: '2026-07-11',
        slug: 'session-note',
        scope: 'session',
        userRequest: '会话约束',
        toolsUsed: {},
        summary: '只属于当前会话',
      },
      undefined,
      undefined,
      'session-1',
    );

    updateMemory(
      workingDir,
      '2026-07-11',
      'session-note',
      { scope: 'project', summary: '升级为项目约束' },
      'session-1',
    );

    expect(getAllMemories(workingDir, 'session-1').find((entry) => entry.slug === 'session-note'))
      .toMatchObject({ scope: 'project', summary: '升级为项目约束' });
    expect(getAllMemories(workingDir, 'session-1', 'session')).toEqual([]);
  });

  it('counts memories injected into an agent context and searches structured facts', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    await saveMemory(workingDir, {
      date: '2026-07-11',
      slug: 'fixed-port',
      scope: 'project',
      userRequest: '项目服务配置',
      toolsUsed: {},
      summary: '开发服务配置',
      facts: [
        {
          type: 'fact',
          subject: '项目',
          predicate: '端口固定为',
          object: '5173',
          validity: { start: '2026-07-11' },
          confidence: 1,
        },
      ],
    });

    await expect(loadMemories(workingDir, '5173', 'session-1')).resolves.toContain('5173');
    // Access counts are deferred and only persisted on flush (the read path
    // must stay read-only).
    flushMemoryAccessCounts();
    expect(getAllMemories(workingDir, 'session-1', 'project').find((entry) => entry.slug === 'fixed-port'))
      .toMatchObject({ accessCount: 1 });
  });

  it('groups similar memories into scenes', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    await saveMemory(workingDir, {
      date: '2026-07-11',
      slug: 'react-setup',
      scope: 'project',
      kind: 'task_summary',
      userRequest: '设置 React 项目',
      toolsUsed: { write: 2, read: 1 },
      summary: '创建了 React + TypeScript 项目配置',
      tags: ['react', 'typescript'],
    });

    await saveMemory(workingDir, {
      date: '2026-07-12',
      slug: 'react-components',
      scope: 'project',
      kind: 'task_summary',
      userRequest: '编写 React 组件',
      toolsUsed: { write: 3, edit: 1 },
      summary: '实现了多个 React 组件',
      tags: ['react', 'components'],
    });

    await saveMemory(workingDir, {
      date: '2026-07-13',
      slug: 'vue-router',
      scope: 'project',
      kind: 'task_summary',
      userRequest: '配置 Vue Router',
      toolsUsed: { write: 1, edit: 2 },
      summary: '设置了 Vue Router 路由配置',
      tags: ['vue', 'router'],
    });

    const scenes = getMemScenes(workingDir);
    expect(scenes.length).toBeGreaterThanOrEqual(1);

    const reactScene = scenes.find((s) => s.tags.includes('react'));
    expect(reactScene).toBeDefined();
    expect(reactScene?.entries).toContain('react-setup');
    expect(reactScene?.entries).toContain('react-components');
  });

  it('does not inject pinned global memories when the query is unrelated', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      // A pinned, high-importance global memory about GitHub CLI.
      await saveMemory(workingDir, {
        date: '2026-07-12',
        slug: 'github-cli-available',
        scope: 'global',
        kind: 'project_fact',
        userRequest: '本地有GitHub CLI',
        toolsUsed: {},
        summary: '用户告知本地已安装 GitHub CLI（gh），可以在需要时自行使用。',
        tags: ['gh', 'github-cli', 'tooling'],
        importance: 3,
        pinned: true,
      });

      // Pinned/global memories must still pass the topic gate: an unrelated
      // query must NOT inject them.
      await expect(loadMemories(workingDir, '帮我修一下这个 Vue 组件的样式 bug', 'session-1'))
        .resolves.not.toContain('GitHub CLI');

      // Related query: the global memory should still be injected.
      await expect(loadMemories(workingDir, '用 gh 命令创建一个 GitHub PR', 'session-1')).resolves.toContain(
        'GitHub CLI',
      );
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });

  it('injects a pinned global memory when its tags match a URL-shaped query', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      // Same GitHub-CLI decision memory as the unrelated-query test above, but
      // queried with a bare PR URL: whitespace tokenization yields only the
      // URL and a Chinese phrase, neither of which appears in the memory text.
      // The tags (github-cli -> token github) must carry the match.
      await saveMemory(workingDir, {
        date: '2026-07-12',
        slug: 'github-cli-available',
        scope: 'global',
        kind: 'decision',
        userRequest: '关于使用GitHub CLI',
        toolsUsed: {},
        summary: '用户告知已安装 GitHub CLI（gh），以后所有与 GitHub 相关的操作统一使用 gh 执行。',
        tags: ['gh', 'github-cli', 'tooling', 'decision'],
        importance: 4,
        pinned: true,
      });

      const content = await loadMemories(
        workingDir,
        'https://github.com/maka-agent/maka-agent/pull/2222 解决冲突',
        'session-1',
      );
      expect(content).toContain('GitHub CLI');
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });

  it('lets the relevance judge rescue near-miss memories below the heuristic cutoff', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      // Fill the normal retrieval cap. Near-miss expansion must not add these
      // entries a second time and crowd out the candidate it is meant to rescue.
      for (let i = 0; i < 5; i++) {
        await saveMemory(workingDir, {
          date: `2026-07-${12 + i}`,
          slug: `github-hit-${i}`,
          scope: 'project',
          kind: 'decision',
          userRequest: `Tagged repository operation ${i}`,
          toolsUsed: {},
          summary: `Heuristic GitHub hit ${i}.`,
          tags: ['github'],
        });
      }

      // `maka-agent` overlaps a URL feature weakly enough to stay below
      // MIN_RELEVANCE_SCORE but above the judge recall floor.
      const nearMissKey = '2026-07-20-github-cli-untagged';
      await saveMemory(workingDir, {
        date: '2026-07-20',
        slug: 'github-cli-untagged',
        scope: 'project',
        kind: 'decision',
        userRequest: 'maka-agent',
        toolsUsed: {},
        summary: 'Use the GitHub CLI (gh) for related repository work.',
      });

      const query = 'https://github.com/maka-agent/maka-agent/pull/2222 解决冲突';
      const plain = await loadMemories(workingDir, query, 'session-1');
      expect(plain).not.toContain('GitHub CLI');

      let judgedKeys: string[] = [];
      const judge = async (_query: string, candidates: RelevanceCandidate[]) => {
        judgedKeys = candidates.map((candidate) => candidate.key);
        return new Set([nearMissKey]);
      };
      const content = await loadMemories(workingDir, query, 'session-1', {
        relevanceJudge: judge,
      });

      expect(judgedKeys).toContain(nearMissKey);
      expect(new Set(judgedKeys).size).toBe(judgedKeys.length);
      expect(content).toContain('GitHub CLI');
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });

  it('requires alphanumeric boundaries for reverse tag matches', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      await saveMemory(workingDir, {
        date: '2026-07-20',
        slug: 'test-conventions',
        scope: 'project',
        kind: 'decision',
        userRequest: 'Unit test conventions',
        toolsUsed: {},
        summary: 'Use unit tests for the project.',
        tags: ['test'],
      });

      await expect(loadMemories(workingDir, 'latest release notes', 'session-1'))
        .resolves.not.toContain('Unit test conventions');
      await expect(loadMemories(workingDir, 'test release notes', 'session-1')).resolves.toContain(
        'Unit test conventions',
      );
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });
  it('only injects unpinned global preferences whose topic matches the query', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      // An unpinned global preference about food, unrelated to dev tasks — the
      // exact pattern that used to crowd every conversation via the resident channel.
      await saveMemory(workingDir, {
        date: '2026-07-16',
        slug: 'durable-preference-likes-pear',
        scope: 'global',
        kind: 'preference',
        userRequest: '我说过我喜欢吃梨吧',
        toolsUsed: {},
        summary: '用户确认自己喜欢吃梨，系统记录该偏好信息。',
        importance: 4,
        tags: ['preference', 'auto-promoted'],
        facts: [
          {
            type: 'preference',
            subject: '用户',
            predicate: '喜欢',
            object: '梨',
            validity: { start: '2026-07-11' },
            confidence: 0.9,
          },
        ],
      });

      // Unrelated query: the global preference must NOT be injected anymore.
      await expect(loadMemories(workingDir, '以后GitHub相关操作都使用GitHub cli gh 提交issue和PR', 'session-1'))
        .resolves.not.toContain('梨');

      // Related query: the preference is still injected as before.
      await expect(loadMemories(workingDir, '我想吃梨', 'session-1')).resolves.toContain('梨');
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });

  it('does not inject memories that only share a common question word', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      // Unrelated global task summary that shares only the word "什么" with
      // the query below — the pattern that used to leak in at ~1.7 relevance.
      await saveMemory(workingDir, {
        date: '2026-07-01',
        slug: 'streaming-output-format',
        scope: 'global',
        kind: 'task_summary',
        userRequest: '当前项目是流式输出的格式是什么',
        toolsUsed: {},
        summary: '(无)',
      });

      // The GitHub question shares only "什么": must NOT be injected.
      await expect(loadMemories(workingDir, '和GitHub相关的记忆有什么呀', 'session-1'))
        .resolves.not.toContain('流式输出');

      // A genuinely related query still retrieves it.
      await expect(loadMemories(workingDir, '流式输出的格式', 'session-1')).resolves.toContain('流式输出');
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });

  it('lets the relevance judge drop heuristically-retrieved unrelated memories', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    await saveMemory(workingDir, {
      date: '2026-07-13',
      slug: 'vue-router',
      scope: 'project',
      kind: 'project_fact',
      userRequest: '配置 Vue Router',
      toolsUsed: {},
      summary: '设置了 Vue Router 路由配置',
    });
    await saveMemory(workingDir, {
      date: '2026-07-14',
      slug: 'react-router',
      scope: 'project',
      kind: 'project_fact',
      userRequest: '配置 React Router',
      toolsUsed: {},
      summary: '设置了 React Router 路由配置',
    });

    // Both memories clear the heuristic threshold; the judge keeps only Vue.
    const judge = async (_query: string, candidates: RelevanceCandidate[]) =>
      new Set(candidates.filter((cand) => cand.userRequest.includes('Vue')).map((cand) => cand.key));
    const content = await loadMemories(workingDir, '配置路由', 'session-1', { relevanceJudge: judge });
    expect(content).toContain('Vue Router');
    expect(content).not.toContain('React Router');
  });

  it('drops pinned memories the judge deems unrelated', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    await saveMemory(workingDir, {
      date: '2026-07-12',
      slug: 'pinned-note',
      scope: 'global',
      kind: 'project_fact',
      userRequest: '置顶的全局事项',
      toolsUsed: {},
      // The summary overlaps the query (端口) so it passes the topic gate;
      // only the judge can reject it — which is exactly what this test checks.
      summary: '置顶的全局事项，端口配置相关',
      pinned: true,
    });
    await saveMemory(workingDir, {
      date: '2026-07-13',
      slug: 'port-note',
      scope: 'project',
      kind: 'project_fact',
      userRequest: '项目端口配置',
      toolsUsed: {},
      summary: '开发服务端口固定为 5173',
    });

    const judge = async () => new Set<string>();
    const content = await loadMemories(workingDir, '端口 5173', 'session-1', { relevanceJudge: judge });
    // The pinned memory cleared the heuristic gate but the judge rejects it,
    // so it must NOT survive — pinned memories are judged like everything else.
    expect(content).not.toContain('置顶的全局事项');
    expect(content).not.toContain('5173');
  });

  it('falls back to heuristic results when the judge cannot decide', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    await saveMemory(workingDir, {
      date: '2026-07-13',
      slug: 'vue-router',
      scope: 'project',
      kind: 'project_fact',
      userRequest: '配置 Vue Router',
      toolsUsed: {},
      summary: '设置了 Vue Router 路由配置',
    });
    await saveMemory(workingDir, {
      date: '2026-07-14',
      slug: 'react-router',
      scope: 'project',
      kind: 'project_fact',
      userRequest: '配置 React Router',
      toolsUsed: {},
      summary: '设置了 React Router 路由配置',
    });

    // A judge that cannot decide (null) keeps the heuristic result untouched.
    const judge = async () => null;
    const content = await loadMemories(workingDir, '配置路由', 'session-1', { relevanceJudge: judge });
    expect(content).toContain('Vue Router');
    expect(content).toContain('React Router');
  });

  it('merges same-source memories when returning them for display', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      // Two entries promoted from the very same request (preference + decision),
      // as written before the promote-merge change.
      const source = '以后GitHub相关操作都使用GitHub cli gh 提交issue 提交pr 都是正文是英文 中文在底部折叠';
      await saveMemory(workingDir, {
        date: '2026-08-07',
        slug: 'durable-preference',
        scope: 'global',
        kind: 'preference',
        userRequest: source,
        toolsUsed: {},
        summary: '用户偏好正文英文、中文折叠。',
        importance: 4,
        facts: [
          {
            type: 'preference',
            subject: '用户',
            predicate: '偏好',
            object: '正文使用英文，中文放在底部折叠',
            validity: { start: '2026-08-07' },
            confidence: 1,
          },
        ],
      });
      await saveMemory(workingDir, {
        date: '2026-08-07',
        slug: 'durable-decision',
        scope: 'project',
        kind: 'decision',
        userRequest: source,
        toolsUsed: {},
        summary: '用户决定使用 gh CLI。',
        importance: 4,
        facts: [
          {
            type: 'decision',
            subject: '用户',
            predicate: '决定使用',
            object: 'GitHub CLI (gh)',
            validity: { start: '2026-08-07' },
            confidence: 1,
          },
        ],
      });

      const judge = async (_query: string, candidates: RelevanceCandidate[]) =>
        new Set(candidates.map((cand) => cand.key));
      const result = await loadMemoriesWithEntries(workingDir, '和GitHub相关的记忆有什么呀', 'session-1', {
        relevanceJudge: judge,
      });

      // Both entries collapse into one with facts merged.
      expect(result.entries.length).toBe(1);
      expect(result.entries[0]?.facts?.length).toBe(2);
      expect(result.entries[0]?.kind).toBe('preference');
      expect(result.content).toContain('GitHub CLI (gh)');
      expect(result.content).toContain('中文放在底部折叠');
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });

  it('bounds the resident channel so unpinned project memories still dominate', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      for (let i = 0; i < 4; i++) {
        await saveMemory(workingDir, {
          date: '2026-07-12',
          slug: `global-pinned-${i}`,
          scope: 'global',
          kind: 'project_fact',
          userRequest: `全局事项 ${i}`,
          toolsUsed: {},
          // Only the two highest-importance pinned memories overlap the query
          // (端口); the other two must fail the topic gate and stay out.
          summary: i < 2 ? `全局 pinned 记忆 ${i}，端口相关` : `全局 pinned 记忆 ${i}`,
          importance: i + 1,
          pinned: true,
        });
      }

      await saveMemory(workingDir, {
        date: '2026-07-13',
        slug: 'project-port',
        scope: 'project',
        kind: 'project_fact',
        userRequest: '项目端口配置',
        toolsUsed: {},
        summary: '开发服务端口固定为 5173',
      });

      const content = await loadMemories(workingDir, '端口 5173', 'session-1');
      // The query-relevant project memory is retrieved…
      expect(content).toContain('5173');
      // …and residents are capped at MAX_RESIDENT_MEMORIES (2), not all four.
      const residentHits = [0, 1, 2, 3].filter((i) => content.includes(`全局 pinned 记忆 ${i}`));
      expect(residentHits.length).toBeLessThanOrEqual(2);
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });

  it('applies time validity filtering in search', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    await saveMemory(workingDir, {
      date: '2026-07-01',
      slug: 'expired-note',
      scope: 'project',
      kind: 'ephemeral',
      userRequest: '临时任务',
      toolsUsed: {},
      summary: '已过期的临时任务',
      expiresAt: '2026-07-10T00:00:00.000Z',
    });

    await saveMemory(workingDir, {
      date: '2026-07-11',
      slug: 'active-note',
      scope: 'project',
      kind: 'project_fact',
      userRequest: '项目配置',
      toolsUsed: {},
      summary: '当前有效的项目配置',
      validFrom: '2026-07-11',
    });

    const memories = await loadMemories(workingDir, '配置', undefined);
    expect(memories).not.toContain('已过期的临时任务');
    expect(memories).toContain('当前有效的项目配置');
  });

  it('prioritizes memories with structured facts in retention', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    const facts: StructuredFact[] = [
      {
        type: 'fact',
        subject: '项目',
        predicate: '使用',
        object: 'Node.js',
        validity: { start: '2026-07-11' },
        confidence: 1.0,
      },
    ];

    await saveMemory(workingDir, {
      date: '2026-07-11',
      slug: 'fact-rich',
      scope: 'project',
      kind: 'project_fact',
      userRequest: '项目使用 Node.js',
      toolsUsed: {},
      summary: '项目技术栈信息',
      importance: 1,
      facts,
    });

    for (let i = 0; i < 35; i++) {
      await saveMemory(workingDir, {
        date: `2026-07-${String(i + 12).padStart(2, '0')}`,
        slug: `no-fact-${i}`,
        scope: 'project',
        kind: 'task_summary',
        userRequest: `普通任务 ${i}`,
        toolsUsed: {},
        summary: `没有结构化事实的记忆 ${i}`,
        importance: 1,
      });
    }

    const memories = getAllMemories(workingDir, undefined, 'project');
    expect(memories.map((m) => m.slug)).toContain('fact-rich');
  });

  it('merges memories including facts', () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    const facts1: StructuredFact[] = [
      {
        type: 'fact',
        subject: '项目',
        predicate: '使用',
        object: 'TypeScript',
        validity: { start: '2026-07-11' },
        confidence: 1.0,
      },
    ];

    const facts2: StructuredFact[] = [
      {
        type: 'preference',
        subject: '用户',
        predicate: '喜欢',
        object: '简洁代码',
        validity: { start: '2026-07-11' },
        confidence: 0.9,
      },
    ];

    const entry1: MemoryEntry = {
      date: '2026-07-11',
      slug: 'entry-1',
      scope: 'project',
      userRequest: '使用 TypeScript',
      toolsUsed: { write: 1 },
      summary: '第一个条目',
      facts: facts1,
    };

    const entry2: MemoryEntry = {
      date: '2026-07-12',
      slug: 'entry-2',
      scope: 'project',
      userRequest: '保持代码简洁',
      toolsUsed: { edit: 2 },
      summary: '第二个条目',
      facts: facts2,
    };

    const memories = [entry1, entry2];
    mergeMemories(workingDir, memories, 'merged-entry');

    const mergedMemories = getAllMemories(workingDir, undefined, 'project');
    const merged = mergedMemories.find((m) => m.slug === 'merged-entry');
    expect(merged).toBeDefined();
    expect(merged?.facts).toBeDefined();
    expect(merged?.facts?.length).toBe(2);
  });

  it('round-trips the supersedes chain through storage', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    await saveMemory(workingDir, {
      date: '2026-07-13',
      slug: 'framework-react',
      scope: 'project',
      kind: 'project_fact',
      userRequest: '以后项目使用 React',
      toolsUsed: {},
      summary: '项目框架从 Vue 切换为 React',
      facts: [
        {
          type: 'decision',
          subject: '项目',
          predicate: '使用',
          object: 'React',
          validity: { start: '2026-07-13' },
          confidence: 0.95,
        },
      ],
      supersedes: ['framework-vue'],
    });

    const entry = getAllMemories(workingDir, undefined, 'project').find(
      (m) => m.slug === 'framework-react',
    );
    expect(entry?.supersedes).toEqual(['framework-vue']);
  });

  it('only records sessions that look worth remembering', () => {
    expect(isMemoryWorthSaving('你好', 0)).toBe(false);
    expect(isMemoryWorthSaving('嗯', 0)).toBe(false);
    expect(isMemoryWorthSaving('好的', 0)).toBe(false);
    // Short but tool-backed work is still worth recording.
    expect(isMemoryWorthSaving('改一下样式', 2)).toBe(true);
    // Longer requests are worth recording even without tool calls.
    expect(isMemoryWorthSaving('帮我分析一下这个项目的记忆系统是怎么实现的', 0)).toBe(true);
  });

  it('promotes all durable facts of one request into a single memory', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    await promoteExplicitDurableFacts(workingDir, 'session-1', '以后GitHub相关操作都使用GitHub cli gh，正文用英文', {
      date: '2026-08-07',
      slug: 'session-entry',
      userRequest: '以后GitHub相关操作都使用GitHub cli gh，正文用英文',
      toolsUsed: {},
      summary: '会话摘要',
      scope: 'session',
      facts: [
        {
          type: 'preference',
          subject: '用户',
          predicate: '偏好',
          object: '正文使用英文',
          validity: { start: '2026-08-07' },
          confidence: 1,
        },
        {
          type: 'decision',
          subject: '用户',
          predicate: '决定使用',
          object: 'GitHub CLI (gh)',
          validity: { start: '2026-08-07' },
          confidence: 1,
        },
      ],
    }, 'provider', 'model');

    const all = getAllMemories(workingDir, 'session-1');
    const durable = all.filter((m) => m.slug.startsWith('durable-'));
    // One request must produce exactly one durable memory, not one per type.
    expect(durable.length).toBe(1);
    expect(durable[0]?.scope).toBe('global');
    expect(durable[0]?.kind).toBe('preference');
    expect(durable[0]?.facts?.length).toBe(2);

    // Re-running the same request stays idempotent (no duplicate).
    await promoteExplicitDurableFacts(workingDir, 'session-1', '以后GitHub相关操作都使用GitHub cli gh，正文用英文', {
      date: '2026-08-07',
      slug: 'session-entry-2',
      userRequest: '以后GitHub相关操作都使用GitHub cli gh，正文用英文',
      toolsUsed: {},
      summary: '会话摘要',
      scope: 'session',
      facts: [
        {
          type: 'preference',
          subject: '用户',
          predicate: '偏好',
          object: '正文使用英文',
          validity: { start: '2026-08-07' },
          confidence: 1,
        },
        {
          type: 'decision',
          subject: '用户',
          predicate: '决定使用',
          object: 'GitHub CLI (gh)',
          validity: { start: '2026-08-07' },
          confidence: 1,
        },
      ],
    }, 'provider', 'model');
    const durableAfter = getAllMemories(workingDir, 'session-1').filter((m) =>
      m.slug.startsWith('durable-'),
    );
    expect(durableAfter.length).toBe(1);
  });

  it('preserves co-stored facts when superseding only the contradicting one', async () => {
    const workingDir = createTempDir('suncode-memory-workspace-');

    // Existing durable memory carries two facts: a framework choice (Vue)
    // and an unrelated style preference (简洁). Only the framework fact is
    // about to be contradicted.
    await saveMemory(workingDir, {
      date: '2026-07-13',
      slug: 'durable-project-facts',
      scope: 'project',
      kind: 'project_fact',
      userRequest: '记住项目使用 Vue 且偏好简洁 UI',
      toolsUsed: {},
      summary: '项目框架与 UI 偏好',
      importance: 4,
      facts: [
        {
          type: 'decision',
          subject: '项目',
          predicate: '使用',
          object: 'Vue',
          confidence: 0.9,
        },
        {
          type: 'preference',
          subject: 'UI',
          predicate: '风格',
          object: '简洁',
          confidence: 0.9,
        },
      ],
    });

    await promoteExplicitDurableFacts(workingDir, 'session-1', '以后请记住项目使用 React', {
      date: '2026-07-14',
      slug: 'session-react',
      userRequest: '以后请记住项目使用 React',
      toolsUsed: {},
      summary: '框架切换为 React',
      scope: 'session',
      facts: [
        {
          type: 'decision',
          subject: '项目',
          predicate: '使用',
          object: 'React',
          confidence: 0.95,
        },
      ],
    });

    const existing = getAllMemories(workingDir, 'session-1', 'project');

    // The original entry must NOT be deleted — it still carries the valid
    // style preference.
    const durable = existing.find((m) => m.slug === 'durable-project-facts');
    expect(durable).toBeDefined();
    expect(durable?.facts?.map((f) => f.object)).toEqual(['简洁']);

    // The contradicting framework decision is promoted into a new entry whose
    // supersedes chain records what it replaced.
    const promoted = existing.find(
      (m) => m.slug.startsWith('durable-decision') && m.facts?.some((f) => f.object === 'React'),
    );
    expect(promoted).toBeDefined();
    expect(promoted?.supersedes).toBeUndefined();
  });

describe('legacy memory migration', () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('migrates legacy flat memories into the global scope', () => {
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const legacyDir = join(appDataDir, 'memories');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, '2026-06-24-legacy-test.md'),
      [
        '---',
        'date: 2026-06-24',
        '---',
        '',
        '## 记住端口',
        '',
        '**工具使用**:',
        '  (无)',
        '',
        '**摘要**:',
        '开发服务器使用固定端口 5173。',
        '',
      ].join('\n'),
      'utf-8',
    );
    // Stale auto-generated index that must be cleaned up after migration.
    writeFileSync(
      join(legacyDir, 'MEMORY.md'),
      '<!-- SunCode memory index - auto-generated -->',
      'utf-8',
    );
    writeFileSync(join(legacyDir, 'MEMORY.json'), '[]', 'utf-8');

    const migrated = migrateLegacyFlatMemories(appDataDir);

    expect(migrated).toBe(1);
    const globalFile = join(appDataDir, 'global', 'memories', '2026-06-24-legacy-test.md');
    expect(existsSync(globalFile)).toBe(true);
    expect(existsSync(join(legacyDir, '2026-06-24-legacy-test.md'))).toBe(false);
    expect(existsSync(legacyDir)).toBe(false);

    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;
    try {
      const entries = getAllMemories('some-workspace');
      const legacy = entries.find((entry) => entry.slug === 'legacy-test');
      expect(legacy).toBeDefined();
      expect(legacy?.scope).toBe('global');
      expect(legacy?.summary).toContain('固定端口 5173');
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });

  it('skips flat memories already present at the destination and stays idempotent', () => {
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const legacyDir = join(appDataDir, 'memories');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, '2026-06-24-dupe.md'), '---\ndate: 2026-06-24\n---\n\n## x\n', 'utf-8');
    const globalDir = join(appDataDir, 'global', 'memories');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, '2026-06-24-dupe.md'),
      '---\nmeta: {"date":"2026-06-24","slug":"dupe","scope":"global","summary":"newer"}\n---\n',
      'utf-8',
    );

    expect(migrateLegacyFlatMemories(appDataDir)).toBe(0);
    expect(existsSync(join(globalDir, '2026-06-24-dupe.md'))).toBe(true);
    expect(migrateLegacyFlatMemories(appDataDir)).toBe(0);
  });

  it('normalizes working directory separators for project memory storage', async () => {
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      const withBackslash = 'D:\\project\\test-dir';
      const withForward = 'D:/project/test-dir';

      await saveMemory(withBackslash, {
        date: '2026-07-20',
        slug: 'sep-backslash',
        scope: 'project',
        userRequest: '分隔符测试',
        toolsUsed: {},
        summary: 'backslash path memory',
      });
      await saveMemory(withForward, {
        date: '2026-07-20',
        slug: 'sep-forward',
        scope: 'project',
        userRequest: '分隔符测试',
        toolsUsed: {},
        summary: 'forward slash path memory',
      });

      const memories = getAllMemories(withBackslash);
      const slugs = memories.map((entry) => entry.slug);
      expect(slugs).toContain('sep-backslash');
      expect(slugs).toContain('sep-forward');
      expect(slugs.filter((slug) => slug.startsWith('sep-'))).toHaveLength(2);
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });

  it('migrates project memories from the legacy un-normalized hash location', () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      const legacyHash = createHash('sha256').update(workingDir).digest('hex').slice(0, 16);
      const legacyDir = join(appDataDir, 'projects', legacyHash, 'memories');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(
        join(legacyDir, '2026-08-01-old-location.md'),
        '---\ndate: 2026-08-01\nscope: project\n---\n\n## 旧位置记忆\n',
        'utf-8',
      );

      const moved = migrateLegacyProjectMemories(appDataDir, workingDir);

      expect(moved).toBe(1);
      expect(existsSync(legacyDir)).toBe(false);
      const memories = getAllMemories(workingDir);
      expect(memories.some((entry) => entry.slug === 'old-location')).toBe(true);
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });

  it('reads project memories from the legacy hash location as a fallback', () => {
    const workingDir = createTempDir('suncode-memory-workspace-');
    const appDataDir = createTempDir('suncode-memory-appdata-');
    const previousAppData = process.env.SUNCODE_APP_DATA;
    process.env.SUNCODE_APP_DATA = appDataDir;

    try {
      const legacyHash = createHash('sha256').update(workingDir).digest('hex').slice(0, 16);
      const legacyDir = join(appDataDir, 'projects', legacyHash, 'memories');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(
        join(legacyDir, '2026-08-01-fallback.md'),
        '---\ndate: 2026-08-01\nscope: project\n---\n\n## 兜底记忆\n',
        'utf-8',
      );

      const memories = getAllMemories(workingDir);
      expect(memories.some((entry) => entry.slug === 'fallback')).toBe(true);
    } finally {
      if (previousAppData === undefined) {
        delete process.env.SUNCODE_APP_DATA;
      } else {
        process.env.SUNCODE_APP_DATA = previousAppData;
      }
    }
  });
});

});
