/**
 * Snip & Context Collapse Compression
 *
 * Two intermediate compression layers between prune and full LLM compaction.
 * These are zero-cost (Snip) and low-cost (Context Collapse) operations
 * that often prevent the need for expensive LLM summarization.
 *
 * Layer: Snip — remove unreferenced old tool results
 * Layer: Context Collapse — read-time projection of related message groups
 */

import type { Message, ContentBlock } from '@shared/types';
import {
  groupMessagesByTurn,
  buildMessageTurnMap,
  recentTurnIdsFromGroups,
} from './context-budget';

// ===== Snip: Unreferenced Tool Result Removal =====

/**
 * Snip tool results that are old and unlikely to be referenced again.
 *
 * Heuristic: tool results from N+ turns ago that are > minChars are replaced
 * with a short placeholder. This is zero-cost (no API call needed).
 *
 * Unlike pruneStaleToolResults (which uses token budget), Snip uses age
 * as the primary criterion and targets "likely unreferenced" results.
 */
export function snipUnreferencedResults(
  messages: Message[],
  options: {
    minResultChars?: number; // default 500
    maxAgeTurns?: number; // default 3
    charsPerToken?: number;
  } = {},
): { messages: Message[]; snippedCount: number; snippedTokensSaved: number } {
  const minChars = options.minResultChars ?? 500;
  const maxAge = options.maxAgeTurns ?? 3;
  const cpt = options.charsPerToken ?? 4;

  // Group messages by turn
  const groups = groupMessagesByTurn(messages, cpt);
  const turnMap = buildMessageTurnMap(messages);

  // Identify protected recent turn IDs
  const protectedTurnIds = recentTurnIdsFromGroups(turnMap, maxAge);

  let snippedCount = 0;
  let snippedTokensSaved = 0;

  const result = messages.map((msg) => {
    if (msg.role !== 'tool') return msg;

    const turnId = turnMap.get(msg);
    // Protect recent turns
    if (turnId && protectedTurnIds.has(turnId)) return msg;

    const contentStr = typeof msg.content === 'string' ? msg.content : '';
    if (contentStr.length <= minChars) return msg;

    // Already a placeholder — don't double-snip
    if (contentStr.includes('suncode.archived_tool_result')) return msg;
    if (contentStr.startsWith('[Archived:')) return msg;

    const originalTokens = Math.ceil(contentStr.length / cpt);
    snippedCount++;
    snippedTokensSaved += originalTokens;

    const toolName = msg.toolCallId ? `tool_${msg.toolCallId.slice(0, 8)}` : 'unknown';
    return {
      ...msg,
      content: `[Archived: ${toolName} result — ${contentStr.length} chars]`,
    };
  });

  return { messages: result, snippedCount, snippedTokensSaved };
}

// ===== Context Collapse: Read-Time Projection =====

/**
 * Context collapse: group related message sequences into collapsed summaries.
 *
 * KEY DESIGN: This is a READ-TIME PROJECTION — the original messages are never
 * modified. Instead, we produce a "collapsed view" that the model sees.
 * The collapse is reversible — original details can be restored if needed.
 *
 * Strategy:
 * - Identify runs of tool-heavy turns (multiple tool calls in sequence)
 * - Collapse them into a single summary message
 * - Keep the most recent turns and human-assistant text interactions intact
 */
export interface CollapseGroup {
  turns: Message[][];
  summaryTokens: number;
  originalTokens: number;
}

export function collapseContext(
  messages: Message[],
  options: {
    collapseThreshold?: number; // default 0.7 (fraction of context window to target)
    maxGroupTokens?: number; // default 4096
    charsPerToken?: number;
    keepRecentTurns?: number;
  } = {},
): { collapsedMessages: Message[]; groupsCollapsed: number; tokensSaved: number } {
  const threshold = options.collapseThreshold ?? 0.7;
  const maxGroupTokens = options.maxGroupTokens ?? 4096;
  const cpt = options.charsPerToken ?? 4;
  const keepRecent = options.keepRecentTurns ?? 3;

  // Group by turn
  const groups = groupMessagesByTurn(messages, cpt);

  // Separate system messages
  const systemTurns = groups.filter((g) => g.messages.every((m) => m.role === 'system'));
  const nonSystemTurns = groups.filter((g) => !g.messages.every((m) => m.role === 'system'));

  if (nonSystemTurns.length <= keepRecent) {
    return { collapsedMessages: messages, groupsCollapsed: 0, tokensSaved: 0 };
  }

  const recentTurns = nonSystemTurns.slice(-keepRecent);
  const oldTurns = nonSystemTurns.slice(0, -keepRecent);

  // Estimate total tokens
  const totalTokens = groups.reduce((sum, g) => sum + g.estimatedTokens, 0);
  const targetTokens = Math.floor(totalTokens * threshold);

  // Identify collapsible groups (tool-heavy turns with multiple tool results)
  const collapsibleGroups: CollapseGroup[] = [];
  let remainingOldTurns: typeof oldTurns = [];

  for (const turn of oldTurns) {
    const toolMsgs = turn.messages.filter((m) => m.role === 'tool');
    const assistantMsgs = turn.messages.filter((m) => m.role === 'assistant');

    // Collapsible if: multiple tool results and total tokens > maxGroupTokens/4
    if (toolMsgs.length >= 2 && turn.estimatedTokens > maxGroupTokens / 4) {
      const summary = buildTurnSummary(turn);
      collapsibleGroups.push({
        turns: [turn.messages],
        summaryTokens: Math.ceil(summary.length / cpt),
        originalTokens: turn.estimatedTokens,
      });
    } else {
      remainingOldTurns.push(turn);
    }
  }

  if (collapsibleGroups.length === 0) {
    return { collapsedMessages: messages, groupsCollapsed: 0, tokensSaved: 0 };
  }

  // Build collapsed view
  const collapsedMessages: Message[] = [];

  // System messages first
  for (const t of systemTurns) {
    collapsedMessages.push(...t.messages);
  }

  // Collapsed old turns
  for (const group of collapsibleGroups) {
    collapsedMessages.push({
      role: 'system',
      content: buildTurnSummaryFromMessages(group.turns.flat()),
    });
  }

  // Remaining old turns (not collapsible)
  for (const t of remainingOldTurns) {
    collapsedMessages.push(...t.messages);
  }

  // Recent turns (always intact)
  for (const t of recentTurns) {
    collapsedMessages.push(...t.messages);
  }

  const tokensSaved = collapsibleGroups.reduce((sum, g) => sum + (g.originalTokens - g.summaryTokens), 0);

  return {
    collapsedMessages,
    groupsCollapsed: collapsibleGroups.length,
    tokensSaved,
  };
}

// ===== Helpers =====

function buildTurnSummary(turn: { messages: Message[] }): string {
  return buildTurnSummaryFromMessages(turn.messages);
}

function buildTurnSummaryFromMessages(messages: Message[]): string {
  const parts: string[] = ['[Collapsed turn]'];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractText(msg);
      if (text) parts.push(`User: ${text.slice(0, 200)}`);
    } else if (msg.role === 'assistant') {
      const toolCalls = msg.toolCalls?.length ?? 0;
      if (toolCalls > 0) {
        const names = msg.toolCalls?.map((tc) => tc.name).join(', ') ?? '';
        parts.push(`Assistant: called ${toolCalls} tool(s): ${names}`);
      } else {
        const text = extractText(msg);
        if (text) parts.push(`Assistant: ${text.slice(0, 200)}`);
      }
    } else if (msg.role === 'tool') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const preview = content.slice(0, 100).replace(/\n/g, ' ');
      parts.push(`  Tool result: ${preview}${content.length > 100 ? '...' : ''}`);
    }
  }

  return parts.join('\n');
}

function extractText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((b: any) => b.type === 'text')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((b: any) => b.text)
      .join(' ');
  }
  return '';
}
