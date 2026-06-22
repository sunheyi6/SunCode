import type { Message, ContentBlock, TextContent, ToolCallContent } from '@shared/types';
import { CHARS_PER_TOKEN, CONTEXT_SAFETY_MARGIN } from '@shared/constants';

/**
 * Estimate the number of tokens in a message or text.
 * Uses a simple character-based heuristic (4 chars ≈ 1 token).
 * For production, you'd want to use a proper tokenizer (tiktoken, etc.).
 */
export function estimateTokens(textOrMessages: string | Message[]): number {
  if (typeof textOrMessages === 'string') {
    return Math.ceil(textOrMessages.length / CHARS_PER_TOKEN);
  }

  let total = 0;
  for (const msg of textOrMessages) {
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / CHARS_PER_TOKEN);
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') {
          total += Math.ceil(block.text.length / CHARS_PER_TOKEN);
        } else if (block.type === 'thinking') {
          total += Math.ceil(block.text.length / CHARS_PER_TOKEN);
        } else if (block.type === 'tool_call') {
          total += Math.ceil(
            (block.name.length + block.arguments.length) / CHARS_PER_TOKEN,
          );
        }
      }
    }
    // Message overhead
    total += 4;
  }
  return total;
}

export interface CompactionResult {
  compactedMessages: Message[];
  wasCompacted: boolean;
  compactedCount: number;
}

/**
 * Compacts conversation history when approaching context window limits.
 * Keeps the system prompt + most recent messages, summarizes older turns.
 *
 * Strategy:
 * 1. Always keep system messages
 * 2. Keep the last N turns intact (default: 3 complete user/assistant pairs)
 * 3. Replace older turns with a compact summary
 */
export function compactMessages(
  messages: Message[],
  contextWindow: number,
  keepRecentTurns = 3,
): CompactionResult {
  // Find system messages (always keep)
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  // If total tokens are within safe limits, don't compact
  const totalTokens = estimateTokens(messages);
  const safeLimit = contextWindow * CONTEXT_SAFETY_MARGIN;

  if (totalTokens < safeLimit) {
    return { compactedMessages: messages, wasCompacted: false, compactedCount: 0 };
  }

  // Find the last N "turns" (a turn = one user message + all responses until next user message)
  const turns: Message[][] = [];
  let currentTurn: Message[] = [];

  for (const msg of nonSystemMessages) {
    if (msg.role === 'user' && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(msg);
  }
  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  // If not enough turns to compact, just keep everything
  if (turns.length <= keepRecentTurns) {
    return { compactedMessages: messages, wasCompacted: false, compactedCount: 0 };
  }

  // Keep recent turns
  const recentTurns = turns.slice(-keepRecentTurns);
  const oldTurns = turns.slice(0, -keepRecentTurns);

  // Summarize old turns
  const summaryText = summarizeTurns(oldTurns);

  const summaryMessage: Message = {
    role: 'system',
    content: `[Previous conversation summary]\n${summaryText}`,
  };

  const compactedMessages: Message[] = [
    ...systemMessages,
    summaryMessage,
    ...recentTurns.flat(),
  ];

  return {
    compactedMessages,
    wasCompacted: true,
    compactedCount: oldTurns.reduce((sum, t) => sum + t.length, 0),
  };
}

/**
 * Creates a summary of older conversation turns.
 * This is a simple heuristic; a real implementation would use an LLM for better summaries.
 */
function summarizeTurns(turns: Message[][]): string {
  const summaryParts: string[] = [];

  for (const turn of turns) {
    const userMsg = turn.find((m) => m.role === 'user');
    const assistantMsgs = turn.filter((m) => m.role === 'assistant');

    if (userMsg) {
      const userText = extractText(userMsg);
      const shortText =
        userText.length > 100 ? `${userText.slice(0, 100)}...` : userText;
      summaryParts.push(`User asked: "${shortText}"`);
    }

    for (const am of assistantMsgs) {
      const text = extractText(am);
      const toolCalls = countToolCalls(am);

      if (toolCalls > 0) {
        summaryParts.push(
          `  Assistant: Used ${toolCalls} tool(s). ${text.length > 80 ? `${text.slice(0, 80)}...` : text}`,
        );
      } else if (text) {
        const short =
          text.length > 150 ? `${text.slice(0, 150)}...` : text;
        summaryParts.push(`  Assistant: ${short}`);
      }
    }
  }

  return summaryParts.join('\n');
}

function extractText(msg: Message): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  return msg.content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}

function countToolCalls(msg: Message): number {
  if (typeof msg.content === 'string') {
    return 0;
  }
  if (msg.toolCalls) {
    return msg.toolCalls.length;
  }
  return msg.content.filter((b): b is ToolCallContent => b.type === 'tool_call').length;
}
