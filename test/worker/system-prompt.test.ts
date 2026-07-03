import { describe, expect, test } from 'vitest';
import { buildSystemPrompt } from '../../src/worker/agent/system-prompt';

const baseInput = {
  workingDir: 'D:/project/SunCode',
  tools: [],
  skillsContent: '',
  permissionMode: 'full_access' as const,
};

describe('buildSystemPrompt', () => {
  test('adds a Chinese response language instruction for Chinese user input', () => {
    const prompt = buildSystemPrompt({
      ...baseInput,
      responseLanguage: 'zh',
    });

    expect(prompt).toContain('Respond in Chinese');
    expect(prompt).toContain('streaming partial responses');
  });

  test('adds an English response language instruction for English user input', () => {
    const prompt = buildSystemPrompt({
      ...baseInput,
      responseLanguage: 'en',
    });

    expect(prompt).toContain('Respond in English');
    expect(prompt).toContain('streaming partial responses');
  });
});
