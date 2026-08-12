import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildProjectKnowledgeDocument } from '../../src/worker/agent/project-knowledge';

describe('buildProjectKnowledgeDocument', () => {
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
