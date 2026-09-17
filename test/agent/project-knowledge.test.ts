import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { getGlobalInstructionsPath, loadAgentsMd } from '../../src/worker/agent/agent-instructions';
import { buildProjectKnowledgeDocument, prepareProjectKnowledge } from '../../src/worker/agent/project-knowledge';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('buildProjectKnowledgeDocument', () => {
  it('publishes the same global path the loader reads, including before creation and after updates', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'suncode-knowledge-'));
    temporaryDirectories.push(directory);
    vi.stubEnv('HOME', directory);
    vi.stubEnv('USERPROFILE', join(directory, 'unused-home'));
    vi.stubEnv('SUNCODE_APP_DATA', directory);
    const input = {
      workingDir: directory,
      sessionId: 'session-1',
      settings: { activeProvider: 'openai', activeModel: 'test-model', thinkingLevel: 'high' as const },
    };
    const instructionsPath = getGlobalInstructionsPath();
    expect(instructionsPath).toBe(join(directory, '.suncode', 'AGENTS.md'));
    const reference = prepareProjectKnowledge(input);
    expect(reference).toMatchObject({ entryPath: join(directory, 'sessions', 'session-1', 'runtime', 'project-info.md') });
    expect(readFileSync(reference!.entryPath, 'utf8')).toContain(instructionsPath);
    writeFileSync(join(directory, '.agents.md'), 'Legacy unrelated rule');
    expect(await loadAgentsMd(directory)).toBe('');

    mkdirSync(join(directory, '.suncode'));
    writeFileSync(instructionsPath, 'Global rule');
    writeFileSync(join(directory, 'AGENTS.md'), 'Project rule');
    expect(await loadAgentsMd(directory)).toBe('Project rule\n\nGlobal rule');
    writeFileSync(instructionsPath, 'Global rule\nNew rule');
    expect(await loadAgentsMd(directory)).toContain('New rule');
    writeFileSync(join(directory, 'CLAUDE.md'), 'Preferred project rule');
    expect(await loadAgentsMd(directory)).toBe('Preferred project rule\n\nGlobal rule\nNew rule');

    vi.stubEnv('HOME', '');
    vi.stubEnv('USERPROFILE', directory);
    expect(getGlobalInstructionsPath()).toBe(instructionsPath);
  });

  it('exposes current runtime facts without secrets', () => {
    const document = buildProjectKnowledgeDocument(
      {
        workingDir: String.raw`D:\project\example`,
        sessionId: 'session-1',
        settings: {
          activeProvider: 'openai',
          activeModel: 'gpt-5.2-codex',
          thinkingLevel: 'high',
        },
      },
      join(process.cwd(), 'docs'),
    );

    expect(document).toContain('当前 Provider：`openai`');
    expect(document).toContain('当前模型：`gpt-5.2-codex`');
    expect(document).toContain('思考级别：`high`');
    expect(document).toContain(String.raw`D:\project\example`);
    expect(document).toContain(join(process.cwd(), 'docs', 'README.md'));
    expect(document).not.toContain('sk-secret');
  });
});
