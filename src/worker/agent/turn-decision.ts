/**
 * Turn decision logic — Codex-inspired `needs_follow_up` computation.
 *
 * Replaces the heuristic `isIncompleteProgressText()` approach with a
 * structured decision model: after each LLM response, determine whether
 * the agent turn should continue (more tool calls, pending input) or stop
 * (task complete, budget exhausted, etc.).
 */

import type { ToolCallContent, TurnDecision, TurnTaxonomy } from '@shared/types';
import { TASK_COMPLETE_TOOL_NAME } from '../tools/task-complete';

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
 * Modeled after Codex's approach:
 *   needs_follow_up = hasPendingToolCalls || hasUnreportedToolResults || hasPendingInput
 *
 * For SunCode, tool results are reported synchronously within the same turn,
 * so `hasUnreportedToolResults` is always false at the decision point.
 * The key signals are:
 *   1. Model called tools → execute them, then continue
 *   2. Model called task_complete → explicit stop signal
 *   3. Model produced only text → natural stop (no follow-up needed)
 *   4. Pending user input → continue to process it
 *   5. Budget / abort → stop
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

  // task_complete is an explicit termination signal from the model
  if (input.hasTaskComplete) {
    return {
      needsFollowUp: false,
      decision: { decision: 'stop', reason: 'task_complete', taxonomy: 'completed' },
    };
  }

  // Model called tools → need to execute them and continue
  if (input.toolCalls.length > 0) {
    return {
      needsFollowUp: true,
      decision: { decision: 'continue', reason: 'tool calls pending execution' },
    };
  }

  // No tool calls — the model is done with this turn.
  // But check if there's pending user input that was queued during execution.
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

  // Model produced text without calling tools — natural stop.
  // The model has nothing more to do; its text IS the final answer.
  // Plan Gate in agent-loop.ts will intercept if plan steps are incomplete.
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

/**
 * Check whether tool calls include task_complete (the explicit completion signal).
 */
export function hasTaskCompleteToolCall(toolCalls: ToolCallContent[]): boolean {
  return toolCalls.some((tc) => tc.name === TASK_COMPLETE_TOOL_NAME);
}

/**
 * Find the task_complete tool call in a list, if present.
 */
export function findTaskCompleteCall(toolCalls: ToolCallContent[]): ToolCallContent | undefined {
  return toolCalls.find((tc) => tc.name === TASK_COMPLETE_TOOL_NAME);
}
