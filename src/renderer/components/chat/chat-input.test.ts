// @ts-expect-error Bun provides this module at test runtime; the repo has no Bun type package.
import { describe, expect, test } from 'bun:test';
import { getComposerTextareaHeight } from './chat-input';

describe('getComposerTextareaHeight', () => {
  test('uses the minimum height for short input', () => {
    expect(getComposerTextareaHeight(32)).toBe(64);
  });

  test('uses the content height inside the supported range', () => {
    expect(getComposerTextareaHeight(112)).toBe(112);
  });

  test('caps tall input at the maximum height', () => {
    expect(getComposerTextareaHeight(280)).toBe(200);
  });
});
