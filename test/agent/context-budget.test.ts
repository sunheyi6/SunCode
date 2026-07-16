/**
 * Context Budget — comprehensive test suite.
 *
 * Tests the three-layer context budget pipeline:
 *   1. Stale tool result pruning
 *   2. Token budget turn cap
 *   3. History compaction (high-water trigger)
 */
import { describe, expect, it } from 'vitest';
import type { Message, ContextBudgetPolicy } from '@shared/types';
import { CHARS_PER_TOKEN } from '@shared/constants';
import {
  applyContextBudget,
  pruneStaleToolResults,
  groupMessagesByTurn,
  selectTurnsByBudget,
} from '../../src/worker/agent/context-budget';

// ── Message factories ──

function user(text: string): Message {
  return { role: 'user', content: text };
}

function assistant(text: string, toolCalls?: Message['toolCalls']): Message {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls };
}

function toolResult(toolCallId: string, content: string): Message {
  return { role: 'tool', content, toolCallId };
}

function system(content: string): Message {
  return { role: 'system', content };
}

// ── Policy factory ──

function defaultPolicy(overrides?: Partial<ContextBudgetPolicy>): ContextBudgetPolicy {
  return {
    minRecentTurns: 2,
    charsPerToken: CHARS_PER_TOKEN,
    staleToolResultPrune: {
      enabled: true,
      maxResultTokens: 2048,
      minRecentTurnsFull: 1,
    },
    historyCompact: {
      enabled: false, // disabled by default in tests
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════
// pruneStaleToolResults
// ═══════════════════════════════════════════════════

describe('pruneStaleToolResults', () => {
  it('does not prune small tool results', () => {
    const msgs: Message[] = [
      system('System prompt'),
      user('Read a file'),
      assistant('Let me read it'),
      toolResult('tc1', 'Short output'),
    ];
    const { messages, prunedCount, tokensSaved } = pruneStaleToolResults(
      msgs,
      defaultPolicy(),
    );
    expect(prunedCount).toBe(0);
    expect(tokensSaved).toBe(0);
    // Content should be unchanged
    const toolMsg = messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toBe('Short output');
  });

  it('prunes oversized tool results', () => {
    // Create a tool result that exceeds 2048 tokens (~8K chars with /4 ratio)
    const bigOutput = 'x'.repeat(10_000); // ~2500 estimated tokens
    const msgs: Message[] = [
      system('System prompt'),
      user('Read a large file'),
      assistant('Let me read it'),
      ...Array.from({ length: 5 }, (_, i) => user(`Question ${i}`)), // push old turns back
      ...Array.from({ length: 5 }, (_, i) => toolResult(`tc${i}`, bigOutput)),
    ];

    const { messages, prunedCount, tokensSaved } = pruneStaleToolResults(
      msgs,
      defaultPolicy({ staleToolResultPrune: { enabled: true, maxResultTokens: 2048, minRecentTurnsFull: 0 } }),
    );
    expect(prunedCount).toBeGreaterThan(0);
    expect(tokensSaved).toBeGreaterThan(0);

    // Verify placeholder format
    const prunedTool = messages.find(
      (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('suncode.archived_tool_result'),
    );
    expect(prunedTool).toBeDefined();
    const placeholder = JSON.parse(prunedTool!.content as string);
    expect(placeholder.kind).toBe('suncode.archived_tool_result');
    expect(placeholder.toolCallId).toBeTruthy();
    expect(placeholder.originalTokens).toBeGreaterThan(0);
    expect(placeholder.originalChars).toBe(bigOutput.length);
    expect(placeholder.reason).toBe('pruned_exceeds_budget');
  });

  it('protects recent turn tool results from pruning', () => {
    const bigOutput = 'x'.repeat(10_000);
    const msgs: Message[] = [
      system('System prompt'),
      // Old turn (should be pruned)
      user('First question'),
      assistant('First response'),
      toolResult('tc_old', bigOutput),
      // Recent turn (should be protected — minRecentTurnsFull=1)
      user('Second question'),
      assistant('Second response'),
      toolResult('tc_recent', bigOutput),
    ];

    const { messages, prunedCount } = pruneStaleToolResults(
      msgs,
      defaultPolicy(),
    );
    expect(prunedCount).toBeGreaterThan(0);

    // Recent tool result should still be intact
    const recentTool = messages.find((m) => m.role === 'tool' && m.toolCallId === 'tc_recent')!;
    expect(typeof recentTool.content).toBe('string');
    expect((recentTool.content as string).length).toBe(bigOutput.length);

    // Old tool result should be replaced
    const oldTool = messages.find((m) => m.role === 'tool' && m.toolCallId === 'tc_old')!;
    expect((oldTool.content as string).includes('suncode.archived_tool_result')).toBe(true);
  });

  it('skips already-pruned placeholders', () => {
    const placeholder = JSON.stringify({
      kind: 'suncode.archived_tool_result',
      toolCallId: 'tc1',
      toolName: 'read',
      bodyHash: 'abc123',
      originalTokens: 5000,
      originalChars: 20000,
      reason: 'pruned_exceeds_budget',
    });
    const msgs: Message[] = [
      system('System prompt'),
      user('Question'),
      assistant('Answer'),
      toolResult('tc1', placeholder),
    ];

    const { prunedCount } = pruneStaleToolResults(
      msgs,
      defaultPolicy({ staleToolResultPrune: { enabled: true, maxResultTokens: 2048, minRecentTurnsFull: 0 } }),
    );
    expect(prunedCount).toBe(0); // Already pruned, shouldn't double-count
  });

  it('returns unchanged when prune is disabled', () => {
    const bigOutput = 'x'.repeat(10_000);
    const msgs: Message[] = [
      system('System prompt'),
      user('Question'),
      toolResult('tc1', bigOutput),
    ];

    const { messages, prunedCount } = pruneStaleToolResults(
      msgs,
      defaultPolicy({ staleToolResultPrune: { enabled: false } }),
    );
    expect(prunedCount).toBe(0);
    expect(messages).toEqual(msgs);
  });

  it('respects maxResultTokens threshold', () => {
    // 3000 chars ≈ 750 tokens — should be under a high threshold
    const mediumOutput = 'y'.repeat(3_000);
    const msgs: Message[] = [
      system('System prompt'),
      user('Question'),
      toolResult('tc1', mediumOutput),
    ];

    // maxResultTokens=2048, 750 < 2048 → not pruned
    const { prunedCount } = pruneStaleToolResults(
      msgs,
      defaultPolicy({
        minRecentTurns: 0,
        minRecentTurnsFull: 0,
        staleToolResultPrune: { enabled: true, maxResultTokens: 2048 },
      }),
    );
    expect(prunedCount).toBe(0);
  });

  it('handles empty messages array', () => {
    const { messages, prunedCount } = pruneStaleToolResults(
      [],
      defaultPolicy(),
    );
    expect(prunedCount).toBe(0);
    expect(messages).toEqual([]);
  });

  it('handles non-string tool content', () => {
    const msgs: Message[] = [
      system('System prompt'),
      user('Question'),
      { role: 'tool', content: [{ type: 'text', text: 'array content' }], toolCallId: 'tc1' },
    ];
    const { prunedCount } = pruneStaleToolResults(
      msgs,
      defaultPolicy({ staleToolResultPrune: { enabled: true, maxResultTokens: 2048, minRecentTurnsFull: 0 } }),
    );
    // Non-string content is skipped (pruning only applies to string content)
    expect(prunedCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════
// groupMessagesByTurn
// ═══════════════════════════════════════════════════

describe('groupMessagesByTurn', () => {
  it('groups messages at user boundaries', () => {
    const msgs: Message[] = [
      system('System'),
      user('Q1'),
      assistant('A1'),
      toolResult('tc1', 'output'),
      user('Q2'),
      assistant('A2'),
    ];

    const groups = groupMessagesByTurn(msgs);
    expect(groups.length).toBe(3); // system turn + 2 user turns
    expect(groups[0]!.turnId).toBe('system');
    expect(groups[1]!.turnId).toBe('turn-0');
    expect(groups[2]!.turnId).toBe('turn-1');
  });

  it('groups consecutive non-user messages into same turn', () => {
    const msgs: Message[] = [
      system('System'),
      user('Q1'),
      assistant('A1'),
      toolResult('tc1', 'output1'),
      toolResult('tc2', 'output2'),
      user('Q2'),
      assistant('A2'),
    ];

    const groups = groupMessagesByTurn(msgs);
    // turn-0 should have Q1 + A1 + 2 tool results = 4 messages (user is at boundary)
    const turn0 = groups.find((g) => g.turnId === 'turn-0')!;
    expect(turn0.messages.length).toBe(4); // user + assistant + 2 tools
  });

  it('splits repeated model-tool iterations inside one user request', () => {
    const msgs: Message[] = [
      system('System'),
      user('Fix the color'),
      assistant('Inspecting styles', [
        { type: 'tool_call', id: 'tc1', name: 'read', arguments: '{}' },
      ]),
      toolResult('tc1', 'old styles'),
      assistant('Inspecting tokens', [
        { type: 'tool_call', id: 'tc2', name: 'read', arguments: '{}' },
      ]),
      toolResult('tc2', 'token values'),
      assistant('Applying change', [
        { type: 'tool_call', id: 'tc3', name: 'edit', arguments: '{}' },
      ]),
      toolResult('tc3', 'updated'),
    ];

    const groups = groupMessagesByTurn(msgs);

    expect(groups).toHaveLength(4);
    expect(groups.slice(1).map((group) => group.messages.length)).toEqual([3, 2, 2]);
    expect(groups[1]!.messages[0]!.role).toBe('user');
    expect(groups[2]!.messages[0]!.role).toBe('assistant');
  });

  it('handles messages with only system prompt', () => {
    const msgs: Message[] = [system('System')];
    const groups = groupMessagesByTurn(msgs);
    expect(groups.length).toBe(1);
    expect(groups[0]!.turnId).toBe('system');
  });

  it('handles empty messages', () => {
    const groups = groupMessagesByTurn([]);
    expect(groups.length).toBe(0);
  });

  it('includes token estimates in each group', () => {
    const msgs: Message[] = [
      user('Hello'),
      assistant('Hi there!'),
    ];
    const groups = groupMessagesByTurn(msgs);
    expect(groups[0]!.estimatedTokens).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════
// selectTurnsByBudget
// ═══════════════════════════════════════════════════

describe('selectTurnsByBudget', () => {
  it('keeps all turns when under budget', () => {
    const groups = [
      { turnId: 'turn-0', messages: [], estimatedTokens: 100 },
      { turnId: 'turn-1', messages: [], estimatedTokens: 200 },
      { turnId: 'turn-2', messages: [], estimatedTokens: 300 },
    ];

    const kept = selectTurnsByBudget(groups, { maxTokens: 1000, minRecent: 1 });
    expect(kept.has('turn-0')).toBe(true);
    expect(kept.has('turn-1')).toBe(true);
    expect(kept.has('turn-2')).toBe(true);
  });

  it('drops old turns when over budget', () => {
    const groups = [
      { turnId: 'turn-0', messages: [], estimatedTokens: 500 },
      { turnId: 'turn-1', messages: [], estimatedTokens: 500 },
      { turnId: 'turn-2', messages: [], estimatedTokens: 500 },
    ];

    const kept = selectTurnsByBudget(groups, { maxTokens: 600, minRecent: 1 });
    // Should keep turn-2 (most recent) but drop earlier ones
    expect(kept.has('turn-2')).toBe(true);
    // turn-1: 500 + 500 = 1000 > 600, should be dropped (not mustKeep)
    expect(kept.has('turn-1')).toBe(false);
    expect(kept.has('turn-0')).toBe(false);
  });

  it('always keeps minRecent turns regardless of budget', () => {
    const groups = [
      { turnId: 'turn-0', messages: [], estimatedTokens: 9999 },
      { turnId: 'turn-1', messages: [], estimatedTokens: 9999 },
      { turnId: 'turn-2', messages: [], estimatedTokens: 9999 },
    ];

    const kept = selectTurnsByBudget(groups, { maxTokens: 10, minRecent: 2 });
    // Must keep 2 most recent turns
    expect(kept.has('turn-2')).toBe(true);
    expect(kept.has('turn-1')).toBe(true);
    // turn-0 should be dropped
    expect(kept.has('turn-0')).toBe(false);
  });

  it('keeps the original user objective when old model-tool iterations are dropped', () => {
    const msgs: Message[] = [
      user('Original objective'),
      assistant('a'.repeat(400)),
      toolResult('tc1', 'b'.repeat(400)),
      assistant('c'.repeat(400)),
      toolResult('tc2', 'd'.repeat(400)),
      assistant('recent'),
      toolResult('tc3', 'recent result'),
    ];

    const { messages } = applyContextBudget(
      msgs,
      defaultPolicy({ maxHistoryTokens: 50, minRecentTurns: 1 }),
    );

    expect(messages).toContain(msgs[0]);
    expect(messages.filter((message) => message.role === 'assistant').length).toBeLessThan(3);
  });

  it('always keeps system turns', () => {
    const groups = [
      { turnId: 'system', messages: [], estimatedTokens: 100 },
      { turnId: 'turn-0', messages: [], estimatedTokens: 9999 },
      { turnId: 'turn-1', messages: [], estimatedTokens: 9999 },
    ];

    const kept = selectTurnsByBudget(groups, { maxTokens: 10, minRecent: 1 });
    expect(kept.has('system')).toBe(true);
  });

  it('respects maxTurns cap', () => {
    const groups = [
      { turnId: 'turn-0', messages: [], estimatedTokens: 10 },
      { turnId: 'turn-1', messages: [], estimatedTokens: 10 },
      { turnId: 'turn-2', messages: [], estimatedTokens: 10 },
      { turnId: 'turn-3', messages: [], estimatedTokens: 10 },
      { turnId: 'turn-4', messages: [], estimatedTokens: 10 },
    ];

    const kept = selectTurnsByBudget(groups, { maxTurns: 3, minRecent: 1 });
    expect(kept.size).toBe(3 + 0); // 3 turns + 0 system
    expect(kept.has('turn-4')).toBe(true);
    expect(kept.has('turn-3')).toBe(true);
    expect(kept.has('turn-2')).toBe(true);
    expect(kept.has('turn-1')).toBe(false);
    expect(kept.has('turn-0')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════
// applyContextBudget (integration)
// ═══════════════════════════════════════════════════

describe('applyContextBudget', () => {
  it('returns unchanged messages when under budget', () => {
    const msgs: Message[] = [
      system('System'),
      user('Hello'),
      assistant('Hi!'),
    ];

    const { messages, diagnostic } = applyContextBudget(
      msgs,
      defaultPolicy({ maxHistoryTokens: 100_000 }),
    );
    expect(diagnostic.changed).toBe(false);
    expect(messages).toEqual(msgs);
  });

  it('applies all layers correctly', () => {
    const bigOutput = 'x'.repeat(10_000);
    const msgs: Message[] = [
      system('System prompt'),
      // Many old turns with big tool results
      ...Array.from({ length: 8 }, (_, i) => [
        user(`Question ${i}`),
        assistant(`Answer ${i}`),
        toolResult(`tc${i}`, bigOutput),
      ]).flat(),
      // Recent turn (protected)
      user('Recent question'),
      assistant('Recent answer'),
      toolResult('tc_recent', 'Small output'),
    ];

    const { messages, diagnostic } = applyContextBudget(
      msgs,
      defaultPolicy({
        maxHistoryTokens: 500, // very tight budget
        staleToolResultPrune: {
          enabled: true,
          maxResultTokens: 2048,
          minRecentTurnsFull: 1,
        },
      }),
    );

    expect(diagnostic.changed).toBe(true);

    // Recent tool result should still be intact
    const recentTool = messages.find((m) => m.role === 'tool' && m.toolCallId === 'tc_recent');
    expect(recentTool).toBeDefined();
    expect(recentTool!.content).toBe('Small output');

    // System message should be preserved
    const sysMsg = messages.find((m) => m.role === 'system' && typeof m.content === 'string' && m.content === 'System prompt');
    expect(sysMsg).toBeDefined();
  });

  it('triggers history compact when over high-water mark', () => {
    const longText = 'x'.repeat(500);
    const msgs: Message[] = [
      system('System prompt'),
      ...Array.from({ length: 6 }, (_, i) => [
        user(`Question ${i}: ${longText}`),
        assistant(`Answer ${i}: ${longText}`),
      ]).flat(),
    ];

    const { messages, diagnostic } = applyContextBudget(
      msgs,
      defaultPolicy({
        maxHistoryTokens: 200, // tiny budget forces compaction
        historyCompact: {
          enabled: true,
          highWaterRatio: 0.5,
          keepRecentTurns: 1,
        },
      }),
    );

    expect(diagnostic.changed).toBe(true);
    // Should have a summary message after compaction
    const summaryMsg = messages.find(
      (m) =>
        m.contextKind === 'capacity_summary' &&
        typeof m.content === 'string' &&
        (m.content as string).includes('[Previous conversation summary]'),
    );
    expect(summaryMsg).toBeDefined();
  });

  it('diagnostics reports accurate stats', () => {
    const bigOutput = 'x'.repeat(10_000);
    const msgs: Message[] = [
      system('System'),
      user('Q1'),
      assistant('A1'),
      toolResult('tc1', bigOutput),
      toolResult('tc2', bigOutput),
      user('Q2'),
      assistant('A2'),
      toolResult('tc3', bigOutput),
    ];

    const { diagnostic } = applyContextBudget(
      msgs,
      defaultPolicy({
        staleToolResultPrune: { enabled: true, maxResultTokens: 2048, minRecentTurnsFull: 1 },
      }),
    );

    expect(diagnostic.beforeMessages).toBe(8);
    expect(diagnostic.beforeTokens).toBeGreaterThan(0);
    expect(diagnostic.afterTokens).toBeGreaterThan(0);
    expect(diagnostic.prunedToolResults).toBeGreaterThan(0);
    expect(diagnostic.prunedTokensSaved).toBeGreaterThan(0);
  });
});
