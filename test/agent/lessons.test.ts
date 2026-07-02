import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRelevantLessons, saveLesson } from '../../src/worker/agent/lessons';
import type { LessonEntry } from '../../src/shared/types';

let tempDirs: string[] = [];

function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'suncode-lessons-'));
  tempDirs.push(dir);
  return dir;
}

describe('failure lessons', () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('loads compact relevant lessons for the current request', () => {
    const workingDir = createTempWorkspace();
    const entry: LessonEntry = {
      slug: 'dev-server-port',
      type: 'tool_failure',
      tool: 'bash',
      keywords: ['dev', 'port', '5173'],
      files: ['vite.config.ts'],
      date: '2026-07-02',
      runId: 'run-1',
      title: '固定端口启动失败',
      problem: '开发服务器必须使用固定 5173 端口，不能换端口绕过。',
      rootCause: '启动器和 Vite strictPort 依赖固定端口。',
      solution: '遇到端口占用时先处理占用进程，再使用 bun run dev。',
    };

    saveLesson(workingDir, entry);

    const content = loadRelevantLessons(workingDir, 'dev server 5173 failed');

    expect(content).toContain('固定端口启动失败');
    expect(content).toContain('正确做法: 遇到端口占用时先处理占用进程，再使用 bun run dev。');
    expect(content.length).toBeLessThanOrEqual(1500);
  });
});
