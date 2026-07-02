import { CHARS_PER_TOKEN } from '@shared/constants';
import type { ContentBlock, Message } from '@shared/types';

/**
 * Token counting utilities.
 * Uses character-based heuristic (4 chars ≈ 1 token) as a fast estimate.
 * For production use, a proper tokenizer (e.g., tiktoken via @anthropic-ai/tokenizer)
 * should be used for accurate counts per model.
 */

export interface TokenCount {
  /** Estimated number of tokens */
  tokens: number;
  /** Characters */
  characters: number;
}

/**
 * Count tokens in a plain string using character heuristic.
 */
export function countStringTokens(text: string): TokenCount {
  const chars = text.length;
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
  return { tokens, characters: chars };
}

/**
 * Count tokens in a content block.
 */
export function countBlockTokens(block: ContentBlock): TokenCount {
  switch (block.type) {
    case 'text':
    case 'thinking':
      return countStringTokens(block.text);
    case 'tool_call':
      return countStringTokens(block.name + block.arguments);
    case 'image':
      // Rough estimate: 85 tokens per image (OpenAI convention)
      return { tokens: 85, characters: 0 };
    default:
      return { tokens: 0, characters: 0 };
  }
}

/**
 * Count tokens in a message.
 */
export function countMessageTokens(msg: Message): TokenCount {
  // Role overhead: ~4 tokens
  const total = { tokens: 4, characters: 0 };

  if (typeof msg.content === 'string') {
    const ct = countStringTokens(msg.content);
    total.tokens += ct.tokens;
    total.characters += ct.characters;
  } else {
    for (const block of msg.content) {
      const bt = countBlockTokens(block);
      total.tokens += bt.tokens;
      total.characters += bt.characters;
    }
  }

  // Tool calls have overhead
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      total.tokens += 8 + Math.ceil((tc.name.length + tc.arguments.length) / CHARS_PER_TOKEN);
    }
  }

  return total;
}

/**
 * Count tokens across an array of messages.
 */
export function countMessagesTokens(messages: Message[]): TokenCount {
  return messages.reduce(
    (acc, msg) => {
      const mt = countMessageTokens(msg);
      return {
        tokens: acc.tokens + mt.tokens,
        characters: acc.characters + mt.characters,
      };
    },
    { tokens: 0, characters: 0 },
  );
}

/**
 * Check if messages exceed a percentage of a context window.
 */
export function isContextExceeded(
  messages: Message[],
  contextWindow: number,
  threshold = 0.7,
): boolean {
  const { tokens } = countMessagesTokens(messages);
  return tokens > contextWindow * threshold;
}
