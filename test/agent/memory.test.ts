import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  loadSessionSnapshot,
  mergeMemories,
  saveMemory,
  saveSessionSnapshot,
  updateMemory,
  type MemoryEntry,
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

  it('keeps pinned global memories resident even when the query is unrelated', async () => {
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

      // Pinned/global memories bypass relevance scoring through the bounded
      // resident channel, so they are injected even for unrelated queries.
      await expect(loadMemories(workingDir, '帮我修一下这个 Vue 组件的样式 bug', 'session-1'))
        .resolves.toContain('GitHub CLI');

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
          summary: `全局 pinned 记忆 ${i}`,
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
});
