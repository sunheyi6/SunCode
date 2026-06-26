/**
 * Context Budget Manager — multi-layer context compaction for the agent loop.
 *
 * Three layers, applied in order:
 *   1. Stale Tool Result Prune  — replace oversized tool results with placeholders
 *   2. Token Budget Turn Cap     — keep only recent turns that fit within a token budget
 *   3. History Compact           — fold old turns into a summary when above high-water mark
 *
 * Integrated via the prepareNextTurn hook in agent-loop.ts.
 */

import { createHash } from 'node:crypto';
import type {
  Message,
  ContextBudgetPolicy,
  ContextBudgetDiagnostic,
  ArchivedToolResultPlaceholder,
} from '@shared/types';
import { CHARS_PER_TOKEN } from '@shared/constants';
import { countStringTokens } from '../utils/token-counter';
import { compactMessages } from './compaction';

// ============================================================================
// Types
// ============================================================================

/** A group of messages belonging to one conversational turn. */
export interface TurnGroup {
  turnId: string;
  messages: Message[];
  estimatedTokens: number;
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Apply the full context budget pipeline to a message array.
 * Called from prepareNextTurn after each intermediate turn.
 */
export function applyContextBudget(
  messages: Message[],
  policy: ContextBudgetPolicy,
): { messages: Message[]; diagnostic: ContextBudgetDiagnostic } {
  const charsPerToken = policy.charsPerToken ?? CHARS_PER_TOKEN;
  const beforeTokens = estimateMessagesTokens(messages, charsPerToken);
  const beforeCount = messages.length;

  let working = messages;
  let prunedToolResults = 0;
  let prunedTokensSaved = 0;
  let droppedTurns = 0;
  let compactedTurns = 0;

  // ---- Layer 1: Stale tool result prune ----
  if (policy.staleToolResultPrune?.enabled) {
    const pruneResult = pruneStaleToolResults(working, policy, charsPerToken);
    working = pruneResult.messages;
    prunedToolResults = pruneResult.prunedCount;
    prunedTokensSaved = pruneResult.tokensSaved;
  }

  // ---- Layer 2: Token budget turn cap ----
  const turnGroups = groupMessagesByTurn(working, charsPerToken);
  const maxTokens = policy.maxHistoryTokens;
  const maxTurns = policy.maxHistoryTurns;
  const minRecent = policy.minRecentTurns ?? 2;

  if (maxTokens !== undefined || maxTurns !== undefined) {
    const keptTurnIds = selectTurnsByBudget(turnGroups, { maxTokens, maxTurns, minRecent });
    if (keptTurnIds.size < turnGroups.length) {
      droppedTurns = turnGroups.length - keptTurnIds.size;
      // Build message→turn map for accurate filtering
      const msgTurnMap = buildMessageTurnMap(working);
      working = working.filter((msg) => {
        // Always keep system messages
        if (msg.role === 'system') return true;
        const turnId = msgTurnMap.get(msg);
        return turnId ? keptTurnIds.has(turnId) : true;
      });
    }
  }

  // ---- Layer 3: History compact (high-water trigger) ----
  if (policy.historyCompact?.enabled) {
    const afterLayer2Tokens = estimateMessagesTokens(working, charsPerToken);
    const effectiveMax = maxTokens ?? 128_000;
    const highWater = Math.floor(effectiveMax * (policy.historyCompact.highWaterRatio ?? 0.8));

    if (afterLayer2Tokens > highWater) {
      const compactResult = compactMessages(
        working,
        effectiveMax,
        policy.historyCompact.keepRecentTurns ?? 3,
      );
      if (compactResult.wasCompacted) {
        working = compactResult.compactedMessages;
        compactedTurns = compactResult.compactedCount;
      }
    }
  }

  // ---- Diagnostic ----
  const afterTokens = estimateMessagesTokens(working, charsPerToken);
  const afterCount = working.length;

  const diagnostic: ContextBudgetDiagnostic = {
    changed: beforeCount !== afterCount || prunedToolResults > 0,
    beforeTokens,
    afterTokens,
    beforeMessages: beforeCount,
    afterMessages: afterCount,
    ...(prunedToolResults > 0 ? { prunedToolResults, prunedTokensSaved } : {}),
    ...(droppedTurns > 0 ? { droppedTurns } : {}),
    ...(compactedTurns > 0 ? { compactedTurns } : {}),
  };

  return { messages: working, diagnostic };
}

// ============================================================================
// Layer 1: Stale tool result prune
// ============================================================================

/**
 * Replace oversized tool results with lightweight archive placeholders.
 * Protects the most recent N turns' tool results from pruning.
 */
export function pruneStaleToolResults(
  messages: Message[],
  policy: ContextBudgetPolicy,
  charsPerToken = CHARS_PER_TOKEN,
): { messages: Message[]; prunedCount: number; tokensSaved: number } {
  const prunePolicy = policy.staleToolResultPrune;
  if (!prunePolicy?.enabled) {
    return { messages, prunedCount: 0, tokensSaved: 0 };
  }

  const maxResultTokens = prunePolicy.maxResultTokens ?? 2048;
  const minRecentTurnsFull = Math.max(
    0,
    prunePolicy.minRecentTurnsFull ?? policy.minRecentTurns ?? 1,
  );

  // Build a message → turnId map so tool messages know which turn they belong to
  const messageTurnMap = buildMessageTurnMap(messages);
  // Identify protected turns (most recent N non-system turn IDs)
  const protectedTurnIds = recentTurnIdsFromGroups(messageTurnMap, minRecentTurnsFull);

  let prunedCount = 0;
  let tokensSaved = 0;

  const prunedMessages = messages.map((msg) => {
    // Only prune tool messages with string content
    if (msg.role !== 'tool' || typeof msg.content !== 'string') return msg;

    const turnId = messageTurnMap.get(msg);
    // Protect recent turns
    if (turnId && protectedTurnIds.has(turnId)) return msg;

    // Already a placeholder — skip
    if (isPlaceholderString(msg.content)) return msg;

    // Estimate tokens
    const { tokens } = countStringTokens(msg.content);
    if (tokens <= maxResultTokens) return msg;

    // Create placeholder
    const placeholder = buildPlaceholder(msg, msg.content, tokens);
    prunedCount += 1;
    tokensSaved += tokens - PLACEHOLDER_TOKENS;

    return { ...msg, content: placeholder };
  });

  return { messages: prunedMessages, prunedCount, tokensSaved };
}

// ============================================================================
// Layer 2: Turn-based token budget
// ============================================================================

/**
 * Group messages by turn. A turn starts at each user message and includes
 * all subsequent non-user messages until the next user message.
 */
export function groupMessagesByTurn(
  messages: Message[],
  charsPerToken = CHARS_PER_TOKEN,
): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let currentGroup: Message[] = [];
  let turnIndex = 0;

  for (const msg of messages) {
    // System messages belong to turn 0 (always kept)
    if (msg.role === 'system') {
      // Flush current group if any
      if (currentGroup.length > 0) {
        groups.push(buildTurnGroup(`turn-${turnIndex}`, currentGroup, charsPerToken));
        currentGroup = [];
      }
      // System messages form their own "turn"
      groups.push(buildTurnGroup('system', [msg], charsPerToken));
      continue;
    }

    if (msg.role === 'user' && currentGroup.length > 0) {
      groups.push(buildTurnGroup(`turn-${turnIndex}`, currentGroup, charsPerToken));
      currentGroup = [];
      turnIndex += 1;
    }

    currentGroup.push(msg);
  }

  // Flush any remaining messages as the last turn
  if (currentGroup.length > 0) {
    groups.push(buildTurnGroup(`turn-${turnIndex}`, currentGroup, charsPerToken));
  }

  return groups;
}

/**
 * Select which turns to keep based on token budget.
 * Walks from newest to oldest, keeping turns until budget is exhausted.
 * Always keeps system messages and at least minRecent non-system turns.
 */
export function selectTurnsByBudget(
  groups: TurnGroup[],
  options: { maxTokens?: number; maxTurns?: number; minRecent: number },
): Set<string> {
  const kept = new Set<string>();
  let keptTokens = 0;
  let keptNonSystemTurns = 0;

  // Always keep system turns
  for (const g of groups) {
    if (g.turnId === 'system') {
      kept.add(g.turnId);
    }
  }

  // Walk from newest to oldest (skip system which is already kept)
  const nonSystemGroups = groups.filter((g) => g.turnId !== 'system');

  for (let i = nonSystemGroups.length - 1; i >= 0; i--) {
    const group = nonSystemGroups[i]!;
    const nextCount = keptNonSystemTurns + 1;
    const mustKeep = nextCount <= options.minRecent;

    if (!mustKeep) {
      // Check turn cap
      if (options.maxTurns !== undefined && nextCount > options.maxTurns) break;
      // Check token budget
      if (
        options.maxTokens !== undefined &&
        keptTokens > 0 &&
        keptTokens + group.estimatedTokens > options.maxTokens
      )
        break;
    }

    kept.add(group.turnId);
    keptTokens += group.estimatedTokens;
    keptNonSystemTurns = nextCount;
  }

  return kept;
}

// ============================================================================
// Helpers
// ============================================================================

/** Approximate token count of a placeholder — used for savings estimation. */
const PLACEHOLDER_TOKENS = 45;

function buildPlaceholder(msg: Message, content: string, originalTokens: number): string {
  const bodyHash = createHash('sha256').update(content).digest('hex').slice(0, 16);

  const placeholder: ArchivedToolResultPlaceholder = {
    kind: 'suncode.archived_tool_result',
    toolCallId: msg.toolCallId ?? 'unknown',
    toolName: extractToolName(msg),
    bodyHash,
    originalTokens,
    originalChars: content.length,
    reason: 'pruned_exceeds_budget',
  };

  return JSON.stringify(placeholder);
}

function extractToolName(msg: Message): string {
  // Tool messages don't carry the tool name directly, use toolCallId prefix
  return msg.toolCallId ?? 'unknown';
}

function isPlaceholderString(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return parsed?.kind === 'suncode.archived_tool_result';
  } catch {
    return false;
  }
}

function buildTurnGroup(turnId: string, messages: Message[], charsPerToken: number): TurnGroup {
  return {
    turnId,
    messages,
    estimatedTokens: estimateMessagesTokens(messages, charsPerToken),
  };
}

function estimateMessagesTokens(messages: Message[], charsPerToken: number): number {
  return Math.ceil(
    messages.reduce((total, msg) => {
      if (typeof msg.content === 'string') {
        return total + msg.content.length;
      }
      return (
        total +
        msg.content.reduce((sum, block) => {
          if (block.type === 'text' || block.type === 'thinking') {
            return sum + block.text.length;
          }
          if (block.type === 'tool_call') {
            return sum + block.name.length + block.arguments.length;
          }
          return sum;
        }, 0)
      );
    }, 0) / Math.max(1, charsPerToken),
  );
}

function buildMessageTurnMap(messages: Message[]): Map<Message, string> {
  const map = new Map<Message, string>();
  const groups = groupMessagesByTurn(messages);
  for (const group of groups) {
    for (const msg of group.messages) {
      map.set(msg, group.turnId);
    }
  }
  return map;
}

function recentTurnIdsFromGroups(messageTurnMap: Map<Message, string>, count: number): Set<string> {
  if (count <= 0) return new Set();
  // Collect unique non-system turn IDs in document order
  const order: string[] = [];
  const seen = new Set<string>();
  for (const turnId of messageTurnMap.values()) {
    if (turnId === 'system' || seen.has(turnId)) continue;
    seen.add(turnId);
    order.push(turnId);
  }
  return new Set(order.slice(Math.max(0, order.length - count)));
}
