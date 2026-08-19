import { describe, expect, test } from 'vitest';
import { buildRuntimeContextMessage } from '../../src/worker/agent/runtime-context';

describe('buildRuntimeContextMessage', () => {
  test('adds a Chinese response language instruction for Chinese user input', () => {
    const message = buildRuntimeContextMessage({
      responseLanguage: 'zh',
      currentDate: '2026-08-19',
    });
    const prompt = String(message.content);

    expect(prompt).toContain('Respond in Chinese');
    expect(message.contextKind).toBe('runtime_context');
  });

  test('adds an English response language instruction for English user input', () => {
    const message = buildRuntimeContextMessage({
      responseLanguage: 'en',
      currentDate: '2026-08-19',
    });
    const prompt = String(message.content);

    expect(prompt).toContain('Respond in English');
    expect(prompt).toContain('trusted_runtime_state');
  });
});
