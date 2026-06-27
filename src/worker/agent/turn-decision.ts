/**
 * Turn decision logic — simplified follow-up computation.
 *
 * After each LLM response, determine whether the agent turn should continue
 * (more tool calls, pending input) or stop (model finished, budget, abort).
 *
 * Design follows pi-agent-core: rely on the LLM's native stop signals
 * (stopReason, tool calls) rather than parsing output text for markers.
 */

import type { ToolCallContent, TurnDecision, TurnTaxonomy } from '@shared/types';

/** Input to the needs-follow-up computation. */
export interface NeedsFollowUpInput {
  /** Tool calls the model emitted in this turn. */
  toolCalls: ToolCallContent[];
  /** Whether there is pending user input queued (e.g. user typed while agent was running). */
  hasPendingInput: boolean;
  /** Whether the current turn count has reached the max. */
  isMaxTurnsReached: boolean;
  /** Whether the abort signal has been triggered. */
  isAborted: boolean;
  /** The assistant's visible text output (may be empty if only tool calls). */
  assistantText: string;
  /** Whether the model explicitly called task_complete. */
  hasTaskComplete: boolean;
}

/**
 * Compute whether the agent loop needs another turn (follow-up).
 *
 * Key signals:
 *   1. Model called tools → execute them, then continue
 *   2. Model produced only text → natural stop (no follow-up needed)
 *   3. Pending user input → continue to process it
 *   4. Budget / abort → stop
 */
export function computeNeedsFollowUp(input: NeedsFollowUpInput): {
  needsFollowUp: boolean;
  decision: TurnDecision;
} {
  // Abort always wins
  if (input.isAborted) {
    return {
      needsFollowUp: false,
      decision: { decision: 'stop', reason: 'aborted', taxonomy: 'aborted' },
    };
  }

  // Model called tools → need to execute them and continue
  if (input.toolCalls.length > 0) {
    return {
      needsFollowUp: true,
      decision: { decision: 'continue', reason: 'tool calls pending execution' },
    };
  }

  // No tool calls — the model finished its response.
  // Check for pending user input first.
  if (input.hasPendingInput) {
    return {
      needsFollowUp: true,
      decision: { decision: 'continue', reason: 'pending user input' },
    };
  }

  // Max turns reached — stop even if model isn't done
  if (input.isMaxTurnsReached) {
    return {
      needsFollowUp: false,
      decision: { decision: 'stop', reason: 'max_turns', taxonomy: 'max_turns_exhausted' },
    };
  }

  // No tool calls, no pending input — model finished its turn naturally.
  return {
    needsFollowUp: false,
    decision: { decision: 'stop', reason: 'no_follow_up', taxonomy: 'completed' },
  };
}

/**
 * Determine the terminal taxonomy from an error thrown during the agent loop.
 */
export function taxonomyFromError(error: unknown): TurnTaxonomy {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'aborted';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('已中止') || message.includes('aborted') || message.includes('AbortError')) {
    return 'aborted';
  }
  return 'error';
}
