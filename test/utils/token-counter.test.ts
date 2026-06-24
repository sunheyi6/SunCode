/**
 * Token Counter — comprehensive test suite.
 *
 * Tests the character-based heuristic token estimation used in
 * compaction and context window management.
 */
import { describe, expect, it } from 'vitest';
import type { Message } from '@shared/types';
import { countStringTokens, countMessageTokens, countMessagesTokens, isContextExceeded } from '../../src/worker/utils/token-counter';
import { CHARS_PER_TOKEN } from '@shared/constants';

// ═══════════════════════════════════════════════════
// countStringTokens
// ═══════════════════════════════════════════════════

describe('countStringTokens', () => {
  it('empty string returns 0 tokens', () => {
    expect(countStringTokens('').tokens).toBe(0);
    expect(countStringTokens('').characters).toBe(0);
  });

  it('exactly CHARS_PER_TOKEN characters returns 1 token', () => {
    const text = 'x'.repeat(CHARS_PER_TOKEN);
    expect(countStringTokens(text).tokens).toBe(1);
    expect(countStringTokens(text).characters).toBe(CHARS_PER_TOKEN);
  });

  it('CHARS_PER_TOKEN + 1 characters returns 2 tokens (ceil)', () => {
    const text = 'x'.repeat(CHARS_PER_TOKEN + 1);
    expect(countStringTokens(text).tokens).toBe(2);
  });

  it('handles multi-byte characters', () => {
    const text = '你好世界'; // 4 characters
    const result = countStringTokens(text);
    expect(result.characters).toBe(4);
    expect(result.tokens).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════
// countMessageTokens
// ═══════════════════════════════════════════════════

describe('countMessageTokens', () => {
  it('counts string content with role overhead', () => {
    const msg: Message = { role: 'user', content: 'Hello', timestamp: 0 };
    const result = countMessageTokens(msg);
    // 4 tokens overhead + ceil(5/CHARS_PER_TOKEN) for "Hello"
    expect(result.tokens).toBe(4 + Math.ceil(5 / CHARS_PER_TOKEN));
  });

  it('counts array content blocks', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello world' },
        { type: 'text', text: 'Second block' },
      ],
      timestamp: 0,
    };
    const result = countMessageTokens(msg);
    const expected = 4 + Math.ceil(11 / CHARS_PER_TOKEN) + Math.ceil(12 / CHARS_PER_TOKEN);
    expect(result.tokens).toBe(expected);
  });

  it('counts thinking blocks', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'thinking', text: 'Internal reasoning...' }],
      timestamp: 0,
    };
    const result = countMessageTokens(msg);
    expect(result.tokens).toBeGreaterThan(4);
  });

  it('counts tool_call blocks', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'tool_call', name: 'read', arguments: 'file.txt' }],
      timestamp: 0,
    };
    const result = countMessageTokens(msg);
    // 4 overhead + ceil((4 + 8) / CHARS_PER_TOKEN)
    expect(result.tokens).toBe(4 + Math.ceil(12 / CHARS_PER_TOKEN));
  });

  it('counts images as 85 tokens', () => {
    const msg: Message = {
      role: 'user',
      content: [{ type: 'image', data: 'base64...', mimeType: 'image/png' }],
      timestamp: 0,
    };
    const result = countMessageTokens(msg);
    expect(result.tokens).toBe(4 + 85); // 4 overhead + 85 per image
  });

  it('counts toolCalls overhead', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done' }],
      toolCalls: [
        { id: 'tc1', name: 'read', arguments: '{"file_path":"x"}' },
        { id: 'tc2', name: 'bash', arguments: '{"command":"ls"}' },
      ],
      timestamp: 0,
    };
    const result = countMessageTokens(msg);
    // Base text + 2 tool calls overhead
    const textTokens = 4 + Math.ceil(4 / CHARS_PER_TOKEN);
    const tc1Tokens = 8 + Math.ceil((4 + 19) / CHARS_PER_TOKEN);
    const tc2Tokens = 8 + Math.ceil((4 + 16) / CHARS_PER_TOKEN);
    expect(result.tokens).toBe(textTokens + tc1Tokens + tc2Tokens);
  });
});

// ═══════════════════════════════════════════════════
// countMessagesTokens
// ═══════════════════════════════════════════════════

describe('countMessagesTokens', () => {
  it('empty array returns 0', () => {
    expect(countMessagesTokens([]).tokens).toBe(0);
  });

  it('sums across multiple messages', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'Hello', timestamp: 0 },
      { role: 'assistant', content: 'Hi there', timestamp: 0 },
    ];
    const result = countMessagesTokens(msgs);
    const individual = msgs.map((m) => countMessageTokens(m).tokens);
    const expected = individual.reduce((a, b) => a + b, 0);
    expect(result.tokens).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════
// isContextExceeded
// ═══════════════════════════════════════════════════

describe('isContextExceeded', () => {
  it('returns false when tokens are under threshold', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'short', timestamp: 0 },
    ];
    // Small content → well under 200k * 0.7
    expect(isContextExceeded(msgs, 200_000)).toBe(false);
  });

  it('returns true when tokens exceed threshold', () => {
    const longText = 'x'.repeat(200_000 * CHARS_PER_TOKEN); // 200k tokens worth
    const msgs: Message[] = [
      { role: 'user', content: longText, timestamp: 0 },
    ];
    // 200k tokens > 100k * 0.7 = 70k
    expect(isContextExceeded(msgs, 100_000)).toBe(true);
  });

  it('uses default threshold of 0.7', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'x'.repeat(80_000 * CHARS_PER_TOKEN), timestamp: 0 },
    ];
    // ~80k tokens > 100k * 0.7 = 70k
    expect(isContextExceeded(msgs, 100_000)).toBe(true);
    // ~80k tokens < 100k * 0.9 = 90k
    expect(isContextExceeded(msgs, 100_000, 0.9)).toBe(false);
  });
});
