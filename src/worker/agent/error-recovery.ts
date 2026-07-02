/**
 * Error Recovery & Continue Sites
 *
 * Handles automatic recovery from common failure modes in the agent loop.
 * Five continue sites, each with a distinct recovery strategy.
 *
 * Key design: Error withholding — recoverable errors are NOT exposed to
 * callers. Only after ALL recovery attempts fail is the error propagated.
 */

import {
  DEFAULT_CONTEXT_OVERFLOW_RECOVERY_ATTEMPTS,
  DEFAULT_MAX_OUTPUT_RECOVERY_ATTEMPTS,
  RECOVERY_MAX_OUTPUT_TOKENS,
} from '@shared/constants';
import type { ContinueSite, RecoveryContext } from '@shared/types';

// ===== Error Classification =====

/**
 * Classify an error from the agent loop into a ContinueSite.
 * Returns null if the error is not recoverable.
 */
export function classifyError(
  error: Error,
  recoveryState?: RecoveryContext | null,
): RecoveryContext | null {
  const message = error.message || '';

  // Check for abort (never recoverable)
  if (error.name === 'AbortError' || message.includes('AbortError') || message.includes('已中止')) {
    return null;
  }

  // max_output_tokens exceeded
  if (
    message.includes('max_output_tokens') ||
    message.includes('output token') ||
    message.includes('max_tokens')
  ) {
    const previousSite = recoveryState?.site;

    // If we already tried escalating, try continuation prompt
    if (previousSite === 'max_output_recovery') {
      const attempt = (recoveryState?.attempt ?? 0) + 1;
      if (attempt <= DEFAULT_MAX_OUTPUT_RECOVERY_ATTEMPTS) {
        return {
          site: 'max_output_continuation',
          attempt,
          maxAttempts: DEFAULT_MAX_OUTPUT_RECOVERY_ATTEMPTS,
        };
      }
      return null; // Exhausted all attempts
    }

    // First attempt: escalate max_output_tokens
    return {
      site: 'max_output_recovery',
      attempt: 1,
      maxAttempts: 1, // Only escalate once, then fall through to continuation
    };
  }

  // Context overflow / prompt too long
  if (
    message.includes('prompt_too_long') ||
    message.includes('context length') ||
    message.includes('too many tokens') ||
    message.includes('context window')
  ) {
    const attempt = (recoveryState?.attempt ?? 0) + 1;
    if (attempt <= DEFAULT_CONTEXT_OVERFLOW_RECOVERY_ATTEMPTS) {
      return {
        site: 'context_overflow_recovery',
        attempt,
        maxAttempts: DEFAULT_CONTEXT_OVERFLOW_RECOVERY_ATTEMPTS,
      };
    }
    return null;
  }

  // Stop hook blocking (shouldBlock with continuationPrompt)
  // This is handled separately — not an error-based recovery

  return null;
}

// ===== Recovery Preparation =====

export interface RecoveryInput {
  /** Adjusted max_output_tokens for retry. */
  maxOutputTokens?: number;
  /** Whether to run emergency compression before retry. */
  emergencyCompact?: boolean;
  /** Continuation prompt to inject. */
  continuationPrompt?: string;
}

/**
 * Prepare recovery parameters based on the continue site.
 */
export function prepareRecovery(site: ContinueSite, attempt: number): RecoveryInput {
  switch (site) {
    case 'max_output_recovery':
      return {
        maxOutputTokens: RECOVERY_MAX_OUTPUT_TOKENS,
      };

    case 'max_output_continuation':
      return {
        maxOutputTokens: RECOVERY_MAX_OUTPUT_TOKENS,
        continuationPrompt:
          attempt === 1
            ? '请继续你的工作。'
            : `继续你的工作（第 ${attempt} 次尝试）。请直接输出最终结果，不要再调用更多工具。`,
      };

    case 'context_overflow_recovery':
      return {
        emergencyCompact: true,
      };

    case 'stop_hook_blocking':
      return {
        continuationPrompt: '请根据之前的反馈调整你的操作。',
      };

    default:
      return {};
  }
}

// ===== Recovery Wrapper =====

/**
 * Wrap an async function with automatic error recovery.
 * Catches recoverable errors and retries with adjusted parameters.
 * Non-recoverable errors propagate immediately.
 */
export async function withRecovery<T>(
  fn: (recoveryInput: RecoveryInput) => Promise<T>,
  options: {
    maxRetries?: number;
    onRecoveryAttempt?: (site: ContinueSite, attempt: number) => void;
  } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  let recoveryState: RecoveryContext | null = null;
  let recoveryInput: RecoveryInput = {};

  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn(recoveryInput);
    } catch (error) {
      const err = error as Error;
      const nextRecovery = classifyError(err, recoveryState);

      if (!nextRecovery) {
        throw error; // Non-recoverable
      }

      recoveryState = nextRecovery;
      recoveryInput = prepareRecovery(nextRecovery.site, nextRecovery.attempt);
      options.onRecoveryAttempt?.(nextRecovery.site, nextRecovery.attempt);

      console.log(
        `[ErrorRecovery] ${nextRecovery.site} attempt ${nextRecovery.attempt}/${nextRecovery.maxAttempts}`,
      );
    }
  }

  throw new Error('Max recovery retries exhausted');
}

// ===== Emergency Compact =====

/**
 * Perform emergency compression — a more aggressive compact triggered
 * when context overflow is detected. Uses snip + collapse + compact
 * sequentially without the normal threshold checks.
 */
export function emergencyCompact(
  messages: import('@shared/types').Message[],
): import('@shared/types').Message[] {
  // Simple emergency: keep system messages + last 2 user-assistant pairs
  const systemMsgs = messages.filter((m) => m.role === 'system');

  // Find last 3 user messages and keep everything after the third-to-last
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIndices.push(i);
  }

  if (userIndices.length <= 3) {
    return messages; // Not enough history to compact
  }

  // Keep: system messages + messages after the third-to-last user message
  const cutoffIndex = userIndices[userIndices.length - 3];
  const recentMsgs = messages.slice(cutoffIndex);

  // Add a summary marker
  const summaryMsg: import('@shared/types').Message = {
    role: 'system',
    content: `[Previous conversation was truncated due to context limit. The last ${messages.length - cutoffIndex} messages are preserved.]`,
  };

  return [...systemMsgs, summaryMsg, ...recentMsgs];
}
