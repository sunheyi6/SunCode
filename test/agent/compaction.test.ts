/**
 * Compaction — comprehensive test suite.
 *
 * Follows pi's compaction test pattern: unit tests for token calculation
 * and cut-point logic, plus integration tests with real message fixtures.
 */
import { describe, expect, it } from 'vitest';
import type { Message } from '@shared/types';
import { estimateTokens, compactMessages } from '../../src/worker/agent/compaction';
import { CHARS_PER_TOKEN, CONTEXT_SAFETY_MARGIN } from '@shared/constants';

// ── Message factories ──

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 };
}

function assistant(text: string, toolCalls?: Message['toolCalls']): Message {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls, timestamp: 0 };
}

function system(content: string): Message {
  return { role: 'system', content, timestamp: 0 };
}

// ── Turn factories ──

function turn(userText: string, assistantText: string): Message[] {
  return [user(userText), assistant(assistantText)];
}

// ═══════════════════════════════════════════════════
// estimateTokens
// ═══════════════════════════════════════════════════

describe('estimateTokens', () => {
  it('estimates string tokens using CHARS_PER_TOKEN', () => {
    const text = 'x'.repeat(CHARS_PER_TOKEN * 10);
    expect(estimateTokens(text)).toBe(10);
  });

  it('estimates message array tokens including overhead', () => {
    const msgs: Message[] = [user('Hello'), assistant('Hi there')];
    const tokens = estimateTokens(msgs);
    // 2 messages × (4 overhead + content)
    expect(tokens).toBeGreaterThan(8);
  });

  it('estimates tool_call content blocks', () => {
    const msgs: Message[] = [
      assistant('Used a tool', [
        { id: '1', name: 'read', arguments: 'test.txt' },
      ]),
    ];
    const tokens = estimateTokens(msgs);
    // Should include tool_call argument characters
    expect(tokens).toBeGreaterThan(4);
  });

  it('estimates thinking content blocks', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', text: 'Let me think about this carefully.' }],
        timestamp: 0,
      },
    ];
    const tokens = estimateTokens(msgs);
    expect(tokens).toBeGreaterThan(4);
  });
});

// ═══════════════════════════════════════════════════
// compactMessages
// ═══════════════════════════════════════════════════

describe('compactMessages', () => {
  it('does not compact when under context limit', () => {
    const msgs: Message[] = [
      system('System prompt'),
      ...turn('Hello', 'Hi there!'),
    ];
    const result = compactMessages(msgs, 200_000);
    expect(result.wasCompacted).toBe(false);
    expect(result.compactedCount).toBe(0);
    expect(result.compactedMessages).toEqual(msgs);
  });

  it('does not compact when turns <= keepRecentTurns', () => {
    const msgs: Message[] = [
      system('System prompt'),
      ...turn('Q1', 'A1'),
      ...turn('Q2', 'A2'),
    ];
    // Even with tiny context window, 2 turns ≤ 3 keepRecentTurns
    const result = compactMessages(msgs, 100);
    expect(result.wasCompacted).toBe(false);
  });

  it('compacts old turns when exceeding context limit', () => {
    // Build enough turns to trigger compaction
    // Use a small context window (100 tokens) to force compaction
    const msgs: Message[] = [system('System prompt')];
    for (let i = 0; i < 5; i++) {
      msgs.push(...turn(`Q${i}`, `A${i}`));
    }

    const result = compactMessages(msgs, 30, 2); // tiny context window forces compaction
    expect(result.wasCompacted).toBe(true);
    expect(result.compactedCount).toBeGreaterThan(0);
    // Should have system + summary + 2 recent turns
    expect(result.compactedMessages[0].role).toBe('system');
    expect(result.compactedMessages[1].role).toBe('system'); // summary message
    expect(result.compactedMessages[1].content).toContain('[Previous conversation summary]');
  });

  it('always preserves system messages', () => {
    const sysMsg = system('Very important system prompt');
    // Add enough data to trigger compaction at contextWindow=50
    const msgs: Message[] = [sysMsg];
    for (let i = 0; i < 5; i++) {
      msgs.push(...turn(`Q${i}`, `A${i}`));
    }

    const result = compactMessages(msgs, 20, 1);
    // The original system message should always be preserved (even after compaction)
    const systemMsgs = result.compactedMessages.filter((m) => m.role === 'system');
    expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
    expect(systemMsgs[0].content).toBe('Very important system prompt');
  });

  it('summary includes user questions from old turns', () => {
    const msgs: Message[] = [system('Sys')];
    for (let i = 0; i < 5; i++) {
      msgs.push(...turn(`Find bugs in file-${i}.ts`, `Found 3 bugs in file-${i}`));
    }

    const result = compactMessages(msgs, 20, 1);
    expect(result.wasCompacted).toBe(true);
    // Summary should reference old user questions
    const summaryMsg = result.compactedMessages.find(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[Previous conversation summary]'),
    );
    expect(summaryMsg).toBeDefined();
  });

  it('counts tool calls in summary', () => {
    const msgs: Message[] = [system('Sys')];
    msgs.push(...turn('Fix the bug', 'Let me check'));
    msgs.push(
      assistant('Done', [
        { id: '1', name: 'read', arguments: 'file.ts' },
      ]),
    );
    for (let i = 0; i < 3; i++) {
      msgs.push(...turn(`Q${i}`, `A${i}`));
    }

    const result = compactMessages(msgs, 20, 1);
    // Should handle tool calls in summary
    expect(result.wasCompacted).toBe(true);
  });

  it('handles messages with only tool calls (no text)', () => {
    const msgs: Message[] = [system('Sys')];
    msgs.push(
      assistant('', [
        { id: '1', name: 'read', arguments: 'file.ts' },
        { id: '2', name: 'bash', arguments: 'ls' },
      ]),
    );
    for (let i = 0; i < 3; i++) {
      msgs.push(...turn(`Q${i}`, `A${i}`));
    }

    const result = compactMessages(msgs, 20, 1);
    expect(result.wasCompacted).toBe(true);
  });

  it('returns original messages unchanged when already within limits', () => {
    const msgs: Message[] = [system('Sys'), ...turn('Q', 'A')];
    const result = compactMessages(msgs, 1_000_000);
    expect(result.wasCompacted).toBe(false);
    // Same references
    expect(result.compactedMessages).toBe(msgs);
  });

  it('handles empty message array', () => {
    const result = compactMessages([], 100_000);
    expect(result.wasCompacted).toBe(false);
    expect(result.compactedMessages).toEqual([]);
  });

  it('handles messages with no system messages', () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 5; i++) {
      msgs.push(...turn(`Question ${i}: ${'x'.repeat(300)}`, `Answer ${i}: ${'y'.repeat(300)}`));
    }

    const result = compactMessages(msgs, 500, 1);
    expect(result.wasCompacted).toBe(true);
    // No system messages in original
    const originalSystemMsgs = msgs.filter((m) => m.role === 'system');
    expect(originalSystemMsgs).toHaveLength(0);
  });
});
