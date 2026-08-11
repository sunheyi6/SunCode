/**
 * Context Budget Manager — multi-layer context compaction for the agent loop.
 *
 * Layers, applied in order (escalating cost):
 *   0. Tool Result Prune         — archive-backed rewrite of oversized tool results
 *   1. Token Budget Turn Cap     — keep only recent turns that fit within a token budget
 *   2. History Compact           — fold old turns into a summary when above high-water mark
 *
 * Invariant: prune projection, never ledger. Archive before omission.
 * Integrated via the prepareNextTurn hook in agent-loop.ts.
 */

import { CHARS_PER_TOKEN } from '@shared/constants';
import type {
  ArchivedToolResultPlaceholder,
  ContextBudgetDiagnostic,
  ContextBudgetOptions,
  ContextBudgetPolicy,
  Message,
  ToolResultPruneReason,
} from '@shared/types';
import { countStringTokens } from '../utils/token-counter';
import { compactMessages } from './compaction';
import { archiveToolResultBody } from './tool-result-archive';

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
  options?: ContextBudgetOptions,
): { messages: Message[]; diagnostic: ContextBudgetDiagnostic } {
  const charsPerToken = policy.charsPerToken ?? CHARS_PER_TOKEN;
  const beforeTokens = estimateMessagesTokens(messages, charsPerToken);
  const beforeCount = messages.length;

  let working = messages;
  let prunedToolResults = 0;
  let estimatedTokensSaved = 0;
  let archiveFailures = 0;
  let droppedTurns = 0;
  let compactedTurns = 0;

  // ---- Layer 0: Tool result prune (archive-backed rewrite) ----
  if (policy.toolResultPrune?.enabled) {
    const pruneResult = pruneToolResults(working, policy, charsPerToken, options);
    working = pruneResult.messages;
    prunedToolResults = pruneResult.prunedCount;
    estimatedTokensSaved = pruneResult.tokensSaved;
    archiveFailures = pruneResult.archiveFailures;
  }

  // ---- Layer 1: Token budget turn cap ----
  const turnGroups = groupMessagesByTurn(working, charsPerToken);
  const maxTokens = policy.maxHistoryTokens;
  const maxTurns = policy.maxHistoryTurns;
  const minRecent = policy.minRecentTurns ?? 2;

  if (maxTokens !== undefined || maxTurns !== undefined) {
    const keptTurnIds = selectTurnsByBudget(turnGroups, { maxTokens, maxTurns, minRecent });
    if (keptTurnIds.size < turnGroups.length) {
      droppedTurns = turnGroups.length - keptTurnIds.size;
      const msgTurnMap = buildMessageTurnMap(working);
      working = working.filter((msg) => {
        if (msg.role === 'system' || msg.role === 'user') return true;
        const turnId = msgTurnMap.get(msg);
        return turnId ? keptTurnIds.has(turnId) : true;
      });
    }
  }

  // ---- Layer 2: History compact (high-water trigger, last resort) ----
  if (policy.historyCompact?.enabled) {
    const afterLayer1Tokens = estimateMessagesTokens(working, charsPerToken);
    const effectiveMax = maxTokens ?? 128_000;
    const highWater = Math.floor(effectiveMax * (policy.historyCompact.highWaterRatio ?? 0.8));

    if (afterLayer1Tokens > highWater) {
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
    changed: beforeCount !== afterCount || prunedToolResults > 0 || archiveFailures > 0,
    beforeTokens,
    afterTokens,
    beforeMessages: beforeCount,
    afterMessages: afterCount,
    ...(prunedToolResults > 0 ? { prunedToolResults, estimatedTokensSaved } : {}),
    ...(archiveFailures > 0 ? { archiveFailures } : {}),
    ...(droppedTurns > 0 ? { droppedTurns } : {}),
    ...(compactedTurns > 0 ? { compactedTurns } : {}),
  };

  return { messages: working, diagnostic };
}

// ============================================================================
// Tool result prune (archive-backed rewrite)
// ============================================================================

/**
 * Rewrite oversized tool results (over maxResultTokens) with archive
 * placeholders before the next model step. Every tool result in every turn is
 * judged by the same rule — there is no recent/historical split, so this runs
 * uniformly after each step. Archive-before-omit: keep the original
 * provider-visible body when archiving fails.
 */
export function pruneToolResults(
  messages: Message[],
  policy: ContextBudgetPolicy,
  _charsPerToken = CHARS_PER_TOKEN,
  options?: ContextBudgetOptions,
): { messages: Message[]; prunedCount: number; tokensSaved: number; archiveFailures: number } {
  const prunePolicy = policy.toolResultPrune;
  if (!prunePolicy?.enabled) {
    return { messages, prunedCount: 0, tokensSaved: 0, archiveFailures: 0 };
  }

  const maxResultTokens = prunePolicy.maxResultTokens ?? 2048;
  const messageTurnMap = buildMessageTurnMap(messages);
  const toolNameByCallId = buildToolNameIndex(messages, options?.archiveDir);

  return rewriteEligibleToolResults(messages, {
    maxResultTokens,
    turnIdFor: (msg) => messageTurnMap.get(msg),
    toolNameByCallId,
    options,
  });
}

interface RewriteArgs {
  maxResultTokens: number;
  turnIdFor: (msg: Message) => string | undefined;
  toolNameByCallId: Map<string, ToolCallMeta>;
  options?: ContextBudgetOptions;
}

function rewriteEligibleToolResults(
  messages: Message[],
  args: RewriteArgs,
): { messages: Message[]; prunedCount: number; tokensSaved: number; archiveFailures: number } {
  let prunedCount = 0;
  let tokensSaved = 0;
  let archiveFailures = 0;

  const prunedMessages = messages.map((msg) => {
    if (msg.role !== 'tool' || typeof msg.content !== 'string') return msg;
    if (isPlaceholderString(msg.content)) return msg;

    // Recovery reads of archived tool results must not be pruned again, or the
    // model chases its own tail: archive → read artifact → archive the read
    // output (which is larger due to formatting) → read again, forever.
    if (args.toolNameByCallId.get(msg.toolCallId ?? '')?.recovery) return msg;

    const { tokens } = countStringTokens(msg.content);
    if (tokens <= args.maxResultTokens) return msg;

    const archived = archiveToolResultBody(
      args.options?.archiveDir,
      msg.toolCallId ?? 'unknown',
      msg.content,
    );
    if (!archived?.artifactId?.trim()) {
      archiveFailures += 1;
      // Fail open: keep original provider-visible body.
      return msg;
    }

    const placeholder = buildPlaceholder({
      msg,
      content: msg.content,
      tokens,
      toolNameByCallId: args.toolNameByCallId,
      archive: archived,
      reason: 'tool_result_pruned',
      turnId: args.turnIdFor(msg),
    });
    prunedCount += 1;
    tokensSaved += Math.max(0, tokens - PLACEHOLDER_TOKENS);

    return { ...msg, content: placeholder };
  });

  return { messages: prunedMessages, prunedCount, tokensSaved, archiveFailures };
}

// ============================================================================
// Layer 2: Turn-based token budget
// ============================================================================

/**
 * Group messages by model-tool iteration. A user message starts a fresh group,
 * and every later assistant response starts another group with its following
 * tool results. This lets a single long-running user request shed old loop
 * iterations instead of treating the entire run as one protected turn.
 */
export function groupMessagesByTurn(
  messages: Message[],
  charsPerToken = CHARS_PER_TOKEN,
): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let currentGroup: Message[] = [];
  let turnIndex = 0;

  const flushCurrentGroup = (): void => {
    if (currentGroup.length === 0) return;
    groups.push(buildTurnGroup(`turn-${turnIndex}`, currentGroup, charsPerToken));
    currentGroup = [];
    turnIndex += 1;
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      flushCurrentGroup();
      groups.push(buildTurnGroup('system', [msg], charsPerToken));
      continue;
    }

    if (msg.role === 'user') {
      flushCurrentGroup();
    } else if (msg.role === 'assistant' && currentGroup.some((item) => item.role === 'assistant')) {
      flushCurrentGroup();
    }

    currentGroup.push(msg);
  }

  flushCurrentGroup();

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

  for (const g of groups) {
    if (g.turnId === 'system') {
      kept.add(g.turnId);
    }
  }

  const nonSystemGroups = groups.filter((g) => g.turnId !== 'system');

  for (let i = nonSystemGroups.length - 1; i >= 0; i--) {
    const group = nonSystemGroups[i]!;
    const nextCount = keptNonSystemTurns + 1;
    const mustKeep = nextCount <= options.minRecent;

    if (!mustKeep) {
      if (options.maxTurns !== undefined && nextCount > options.maxTurns) break;
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
const PLACEHOLDER_TOKENS = 80;

function buildPlaceholder(args: {
  msg: Message;
  content: string;
  tokens: number;
  toolNameByCallId: Map<string, ToolCallMeta>;
  archive: { artifactId: string; bodySha256: string; originalBytes: number; absolutePath: string };
  reason: ToolResultPruneReason;
  turnId?: string;
}): string {
  const toolCallId = args.msg.toolCallId ?? 'unknown';
  const toolName =
    (args.msg.toolCallId ? args.toolNameByCallId.get(args.msg.toolCallId)?.name : undefined) ??
    extractToolNameFromContent(args.content) ??
    'unknown';

  const placeholder: ArchivedToolResultPlaceholder = {
    kind: 'suncode.archived_tool_result',
    schemaVersion: 1,
    toolCallId,
    toolName,
    artifactId: args.archive.artifactId,
    bodySha256: args.archive.bodySha256,
    bodyHash: args.archive.bodySha256.slice(0, 16),
    originalTokens: args.tokens,
    originalBytes: args.archive.originalBytes,
    originalChars: args.content.length,
    reason: args.reason,
    rewriteVersion: 1,
    turnId: args.turnId,
    artifactPath: args.archive.absolutePath,
    recoveryHint: `Archived full tool result (artifactId=${args.archive.artifactId}) at ${args.archive.absolutePath}. Use the read tool on that path if you need the omitted content. Do not re-run the ${toolName} tool if it may have side effects.`,
  };

  return JSON.stringify(placeholder);
}

/** Tool call metadata used by prune decisions. */
interface ToolCallMeta {
  name: string;
  /** True when the call reads back an archived tool result (recovery read). */
  recovery: boolean;
}

/**
 * Resolve tool names and recovery-read flags from assistant toolCalls and
 * model-facing tool result JSON.
 */
function buildToolNameIndex(messages: Message[], archiveDir?: string): Map<string, ToolCallMeta> {
  const map = new Map<string, ToolCallMeta>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (!tc.id) continue;
        map.set(tc.id, {
          name: tc.name ?? 'unknown',
          recovery: toolCallTargetsArchiveDir(tc.arguments, archiveDir),
        });
      }
    }
    if (msg.role === 'tool' && msg.toolCallId && typeof msg.content === 'string') {
      const name = extractToolNameFromContent(msg.content);
      if (name) {
        const existing = map.get(msg.toolCallId);
        map.set(msg.toolCallId, { name, recovery: existing?.recovery ?? false });
      }
    }
  }
  return map;
}

/**
 * True when a tool call's JSON arguments reference a file inside the archive
 * directory — i.e. the call is a recovery read of a previously pruned result.
 * Arguments are JSON, so backslashes are escaped (\\ in the raw string); both
 * sides are normalized to forward slashes before comparison.
 */
function toolCallTargetsArchiveDir(
  argsJson: string | undefined,
  archiveDir: string | undefined,
): boolean {
  if (!argsJson || !archiveDir) return false;
  const normArchive = archiveDir.replace(/\\/g, '/').toLowerCase();
  const normArgs = argsJson.replace(/\\\\/g, '/').toLowerCase();
  return normArgs.includes(normArchive);
}

function extractToolNameFromContent(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { tool?: unknown; toolName?: unknown };
    if (typeof parsed.tool === 'string' && parsed.tool) return parsed.tool;
    if (typeof parsed.toolName === 'string' && parsed.toolName) return parsed.toolName;
  } catch {
    // plain text tool body
  }
  return undefined;
}

function isPlaceholderString(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { kind?: unknown };
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

export function estimateMessagesTokens(messages: Message[], charsPerToken: number): number {
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

export function buildMessageTurnMap(messages: Message[]): Map<Message, string> {
  const map = new Map<Message, string>();
  const groups = groupMessagesByTurn(messages);
  for (const group of groups) {
    for (const msg of group.messages) {
      map.set(msg, group.turnId);
    }
  }
  return map;
}
