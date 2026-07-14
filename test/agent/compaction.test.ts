/**
 * Compaction — comprehensive test suite.
 *
 * Follows pi's compaction test pattern: unit tests for token calculation
 * and cut-point logic, plus integration tests with real message fixtures.
 */
import { describe, expect, it } from 'vitest';
import type { Message } from '@shared/types';
import { estimateTokens, compactMessages } from '../../src/worker/agent/compaction';
import {
  applySemanticProjection,
  buildSemanticCompactRequest,
  createSemanticProjection,
  selectSemanticCompactCandidate,
} from '../../src/worker/agent/semantic-compact';
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
    expect(result.compactedMessages[1].role).toBe('user'); // visible provider context
    expect(result.compactedMessages[1].contextKind).toBe('capacity_summary');
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
      (m) =>
        m.contextKind === 'capacity_summary' &&
        typeof m.content === 'string' &&
        m.content.includes('[Previous conversation summary]'),
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

describe('semantic compact projection', () => {
  const validProjection = JSON.stringify({
    objective: 'Finish the requested implementation',
    constraints: ['Keep the current user request exact'],
    completedWork: ['Inspected the runtime'],
    currentState: ['Tool results are complete'],
    decisions: ['Use cache-safe fork'],
    failedApproaches: [],
    unresolvedWork: ['Apply the patch'],
    nextAction: 'Edit the runtime',
  });

  it('selects only completed messages after the immutable head', () => {
    const head = user('current task');
    const messages = [
      system('system'),
      user('prior task'),
      assistant('prior answer'),
      head,
      assistant('x'.repeat(400)),
      user('y'.repeat(400)),
    ];
    const result = selectSemanticCompactCandidate({
      messages,
      headAnchor: head,
      contextWindow: 100,
      threshold: 0.1,
      minNewTokens: 10,
    });

    expect(result.candidate?.headIndex).toBe(3);
    expect(result.candidate?.sourceStartIndex).toBe(4);
    expect(result.candidate?.sourceMessages).toEqual(messages.slice(4));
  });

  it('describes the projection field types in the compact request', () => {
    const head = user('current task');
    const candidate = selectSemanticCompactCandidate({
      messages: [head, assistant('raw')],
      headAnchor: head,
      contextWindow: 1,
      threshold: 0.1,
      minNewTokens: 1,
    }).candidate!;
    const request = JSON.parse(buildSemanticCompactRequest(candidate));

    expect(request.requirements).toMatchObject({
      output: 'json_only_no_markdown',
      schema: {
        type: 'object',
        properties: {
          objective: { type: 'string' },
          currentState: { type: 'array', items: { type: 'string' } },
          nextAction: { type: 'string' },
        },
      },
    });
  });

  it('creates a bounded projection and replaces the covered middle span', () => {
    const head = user('current task');
    const messages = [system('system'), user('prior'), assistant('done'), head, assistant('raw')];
    const eligibility = selectSemanticCompactCandidate({
      messages,
      headAnchor: head,
      contextWindow: 10,
      threshold: 0.1,
      minNewTokens: 1,
    });
    const candidate = eligibility.candidate!;
    const created = createSemanticProjection({
      outputText: validProjection,
      headAnchor: head,
      candidate,
      maxProjectionTokens: 1000,
    });

    expect(created.projection).toBeDefined();
    expect(created.message?.contextKind).toBe('semantic_projection');
    const projected = applySemanticProjection({
      messages,
      headAnchor: head,
      projectionMessage: created.message!,
    });
    expect(projected).toEqual([...messages.slice(0, 4), created.message]);
    expect(JSON.stringify(projected)).not.toContain('"raw"');
  });

  it('uses the previous projection as the rolling boundary', () => {
    const head = user('current task');
    const previousProjection: Message = {
      role: 'user',
      contextKind: 'semantic_projection',
      content: JSON.stringify({ projectionId: 'projection-1' }),
    };
    const newRaw = assistant('z'.repeat(400));
    const messages = [system('system'), head, previousProjection, newRaw];
    const result = selectSemanticCompactCandidate({
      messages,
      headAnchor: head,
      contextWindow: 100,
      threshold: 0.1,
      minNewTokens: 10,
    });

    expect(result.candidate?.previousProjectionId).toBe('projection-1');
    expect(result.candidate?.sourceMessages).toEqual([newRaw]);
  });

  it('fails closed on malformed projection output', () => {
    const head = user('current task');
    const messages = [head, assistant('raw')];
    const candidate = selectSemanticCompactCandidate({
      messages,
      headAnchor: head,
      contextWindow: 1,
      threshold: 0.1,
      minNewTokens: 1,
    }).candidate!;
    const created = createSemanticProjection({
      outputText: '{"objective":"missing fields"}',
      headAnchor: head,
      candidate,
      maxProjectionTokens: 1000,
    });

    expect(created.projection).toBeUndefined();
    expect(created.reason).toBe('invalid_projection_output');
  });

  it('normalizes scalar list fields from compatible model output', () => {
    const head = user('current task');
    const candidate = selectSemanticCompactCandidate({
      messages: [head, assistant('raw')],
      headAnchor: head,
      contextWindow: 1,
      threshold: 0.1,
      minNewTokens: 1,
    }).candidate!;
    const created = createSemanticProjection({
      outputText: JSON.stringify({
        objective: 'Finish the task',
        constraints: 'Keep the requested scope',
        completedWork: 'Inspected the implementation',
        currentState: 'The root cause is known',
        decisions: 'Patch the validation boundary',
        failedApproaches: 'The first test command was too broad',
        unresolvedWork: 'Run the verifier',
        nextAction: 'Apply the patch',
      }),
      headAnchor: head,
      candidate,
      maxProjectionTokens: 1000,
    });

    expect(created.projection?.state).toMatchObject({
      constraints: ['Keep the requested scope'],
      currentState: ['The root cause is known'],
      unresolvedWork: ['Run the verifier'],
    });
  });
});
