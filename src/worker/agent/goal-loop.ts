/**
 * Goal Loop — autonomous multi-turn execution with evidence-driven completion.
 *
 * Modeled after Codex's /goal feature and maka-agent's autonomous loop.
 *
 * Architecture:
 *   User: /goal "fix all lint errors" --verify "bun run lint"
 *     ↓
 *   ┌─ Goal Loop ────────────────────────────────────┐
 *   │  Turn 1: runAgentLoop() → agent fixes errors    │
 *   │  → Run `bun run lint` → exit 1 (still failing)  │
 *   │  → Feedback injected, continue                  │
 *   │  Turn 2: runAgentLoop() → agent fixes more      │
 *   │  → Run `bun run lint` → exit 0 ✅               │
 *   │  → Goal met, stop                               │
 *   └────────────────────────────────────────────────┘
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DEFAULT_GOAL_MAX_TURNS, DEFAULT_GOAL_MAX_WALL_TIME_MS } from '@shared/constants';
import type {
  GoalDefinition,
  GoalEvent,
  GoalLoopResult,
  GoalState,
  GoalStatus,
  Message,
  TokenUsage,
} from '@shared/types';
import type { AgentLoopInput, AgentLoopResult } from './agent-loop';
import { runAgentLoop } from './agent-loop';
import { createDefaultStopHookRegistry } from './stop-hooks';

/** Parse a /goal command from user input. Returns null if not a goal. */
export function parseGoalFromPrompt(text: string): GoalDefinition | null {
  const trimmed = text.trim();

  // Must start with /goal
  if (!trimmed.startsWith('/goal')) return null;

  // Extract everything after /goal
  const rest = trimmed.slice(5).trim();
  if (!rest) return null;

  // Parse flags: --verify "...", --constraints "..."
  let description = rest;
  let verificationCommand: string | undefined;
  let constraints: string | undefined;

  const verifyMatch = rest.match(/--verify\s+"([^"]+)"/);
  if (verifyMatch) {
    verificationCommand = verifyMatch[1]!;
    description = description.replace(verifyMatch[0], '').trim();
  }

  const constraintsMatch = rest.match(/--constraints?\s+"([^"]+)"/);
  if (constraintsMatch) {
    constraints = constraintsMatch[1]!;
    description = description.replace(constraintsMatch[0], '').trim();
  }

  // Clean up remaining flags
  description = description.replace(/--\w+\s+"[^"]*"/g, '').trim();

  if (!description) return null;

  return {
    description,
    verificationCommand,
    constraints,
  };
}

/** Extract the goal from a prompt. Returns null if not a goal prompt. */
export function extractGoalDefinition(
  text: string,
  defaults?: Partial<GoalDefinition>,
): GoalDefinition | null {
  const parsed = parseGoalFromPrompt(text);
  if (!parsed) return null;

  return {
    description: parsed.description,
    verificationCommand: parsed.verificationCommand ?? defaults?.verificationCommand,
    constraints: parsed.constraints ?? defaults?.constraints,
    maxGoalTurns: defaults?.maxGoalTurns ?? DEFAULT_GOAL_MAX_TURNS,
    maxWallTimeMs: defaults?.maxWallTimeMs ?? DEFAULT_GOAL_MAX_WALL_TIME_MS,
  };
}

/** Input to runGoalLoop. */
export interface GoalLoopInput {
  /** The agent loop configuration (without messages — goal loop manages its own). */
  loopConfig: Omit<AgentLoopInput, 'messages' | 'hasPendingInput' | 'stopHooks'>;
  /** The goal definition. */
  goal: GoalDefinition;
  /** Initial messages (user prompt + any history). */
  messages: Message[];
  /** Callback for goal lifecycle events. */
  onGoalEvent: (event: GoalEvent) => void;
}

/** Result of running the entire goal loop. */
export interface GoalLoopOutput {
  result: GoalLoopResult;
  /** All messages accumulated during the goal (for history). */
  messages: Message[];
}

/**
 * Run the goal loop: repeatedly call the agent, verify, and continue until
 * the goal is met, the budget is exhausted, or the user aborts.
 */
export async function runGoalLoop(input: GoalLoopInput): Promise<GoalLoopOutput> {
  const { loopConfig, goal, messages: initialMessages, onGoalEvent } = input;
  const goalRunId = randomUUID();
  const startedAt = Date.now();
  const now = () => Date.now();

  const maxTurns = goal.maxGoalTurns ?? DEFAULT_GOAL_MAX_TURNS;
  const maxWallTimeMs = goal.maxWallTimeMs ?? DEFAULT_GOAL_MAX_WALL_TIME_MS;

  const goalState: GoalState = {
    definition: goal,
    status: 'active',
    turnsCompleted: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
    startedAt,
  };

  onGoalEvent({ type: 'goal_started', goal, goalRunId });

  const messages = [...initialMessages];
  let totalTurnCount = 0;
  const totalTokens: TokenUsage = { input: 0, output: 0, total: 0 };
  let lastResult: AgentLoopResult | null = null;

  // Track consecutive natural stops (model produces text-only, no task_complete).
  // Two in a row → model firmly believes it's done → accept and stop.
  // Resets when the model makes progress (calls tools) in a goal-level turn.
  let consecutiveNaturalStops = 0;

  console.log(
    `[GoalLoop] Starting goal: "${goal.description.slice(0, 80)}" verify=${goal.verificationCommand || 'none'} maxTurns=${maxTurns}`,
  );

  while (goalState.turnsCompleted < maxTurns) {
    console.log(`[GoalLoop] Turn ${goalState.turnsCompleted + 1}/${maxTurns}`);
    // Check wall time budget
    if (now() - startedAt >= maxWallTimeMs) {
      goalState.status = 'budget_exhausted';
      goalState.reason = `wall time exceeded (${maxWallTimeMs}ms)`;
      onGoalEvent({
        type: 'goal_budget_exhausted',
        reason: goalState.reason,
      });
      break;
    }

    // Check abort signal
    if (loopConfig.abortSignal.aborted) {
      goalState.status = 'aborted';
      onGoalEvent({ type: 'goal_aborted' });
      break;
    }

    // Build the feedback-enhanced prompt for this attempt
    const attemptMessages = buildAttemptMessages(
      messages,
      goal,
      goalState.turnsCompleted,
      lastResult,
    );

    // Run one agent loop attempt
    let result: AgentLoopResult;
    try {
      result = await runAgentLoop({
        ...loopConfig,
        messages: attemptMessages,
        stopHooks: createDefaultStopHookRegistry(),
        hasPendingInput: false,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[GoalLoop] runAgentLoop failed: ${errMsg}`);

      // Treat as a failed attempt, inject error feedback, and continue
      const errorFeedback = `[目标执行出错 — 第 ${goalState.turnsCompleted + 1}/${maxTurns} 次尝试]\n\n错误: ${errMsg}\n\n请根据错误信息调整方法，继续完成目标：${goal.description}\n完成后调用 task_complete。`;

      messages.push({
        role: 'user',
        content: errorFeedback,
      });

      // Emit a turn completed event even on failure
      onGoalEvent({
        type: 'goal_turn_completed',
        turnNumber: goalState.turnsCompleted + 1,
        tokenUsage: totalTokens,
      });

      goalState.turnsCompleted++;
      continue;
    }

    lastResult = result;
    goalState.turnsCompleted++;
    totalTurnCount += result.turnCount;
    totalTokens.input += result.tokenUsage.input;
    totalTokens.output += result.tokenUsage.output;
    totalTokens.total += result.tokenUsage.total;
    goalState.tokenUsage = { ...totalTokens };

    // Push the final message to history
    messages.push(result.finalMessage);

    // Check if the model explicitly declared completion via task_complete.
    // This is the AUTHORITATIVE signal — the model knows if it's done.
    const modelDeclaredDone = result.decision.reason === 'task_complete';

    // Run verification if configured (advisory when model declared done)
    if (goal.verificationCommand) {
      const verification = await runVerification(goal.verificationCommand, loopConfig.workingDir);

      // Capture previous output BEFORE overwriting (for systematic failure detection)
      const prevOutput = goalState.lastVerificationOutput;

      goalState.lastVerificationOutput = verification.output;
      goalState.lastVerificationExitCode = verification.exitCode;

      onGoalEvent({
        type: 'goal_turn_completed',
        turnNumber: goalState.turnsCompleted,
        tokenUsage: result.tokenUsage,
        verificationOutput: verification.output.slice(0, 2000),
        verificationExitCode: verification.exitCode,
      });

      // Model says done → trust the model, end regardless of verification
      if (modelDeclaredDone) {
        if (verification.passed) {
          goalState.status = 'verification_passed';
          onGoalEvent({ type: 'goal_verification_passed', tokenUsage: totalTokens });
        } else {
          // Model declared done but verification failed — log warning but still end
          goalState.status = 'verification_passed';
          goalState.reason = `model declared task_complete; verification command had exitCode=${verification.exitCode} (advisory only)`;
          console.warn(`[GoalLoop] Model declared done but verification failed: exitCode=${verification.exitCode}`);
          onGoalEvent({ type: 'goal_verification_passed', tokenUsage: totalTokens });
        }
        break;
      }

      // Model did NOT declare done — verification is authoritative
      if (verification.exitCode === null && !verification.timedOut) {
        goalState.status = 'blocked';
        goalState.reason = `verification command failed to run: ${verification.output.slice(0, 300)}`;
        console.error(`[GoalLoop] Verification command error (exitCode=null): ${goalState.reason}`);
        onGoalEvent({ type: 'goal_blocked', reason: goalState.reason });
        break;
      }

      if (verification.passed) {
        goalState.status = 'verification_passed';
        onGoalEvent({ type: 'goal_verification_passed', tokenUsage: totalTokens });
        break;
      }

      // Verification failed — check if same error as last time (systematic)
      const isSameError =
        prevOutput &&
        verification.output &&
        prevOutput.slice(-500) === verification.output.slice(-500);
      if (isSameError && goalState.turnsCompleted > 1) {
        goalState.status = 'blocked';
        goalState.reason = 'verification produces same error repeatedly — likely a systematic issue';
        console.error(`[GoalLoop] Systematic verification failure detected`);
        onGoalEvent({ type: 'goal_blocked', reason: goalState.reason });
        break;
      }

      // Inject feedback and continue
      const feedbackMsg = buildVerificationFeedback(
        goal,
        verification,
        goalState.turnsCompleted,
        maxTurns,
      );
      messages.push({ role: 'user', content: feedbackMsg });
    } else {
      // No verification command — model must explicitly call task_complete to end
      onGoalEvent({
        type: 'goal_turn_completed',
        turnNumber: goalState.turnsCompleted,
        tokenUsage: result.tokenUsage,
      });

      if (modelDeclaredDone) {
        goalState.status = 'verification_passed';
        onGoalEvent({ type: 'goal_verification_passed', tokenUsage: totalTokens });
        break;
      }

      // Consecutive natural-stop detection: when the model repeatedly stops
      // with text-only (no task_complete, no tools), it firmly believes the
      // task is done. Two consecutive natural stops → accept as completion.
      // This prevents the "are you done? — yes — are you done? — yes" loop.
      const isNaturalStop = result.decision.reason === 'no_follow_up';
      if (isNaturalStop) {
        consecutiveNaturalStops++;
        console.log(
          `[GoalLoop] Natural stop (no task_complete) — ${consecutiveNaturalStops}/${2} consecutive`,
        );
        if (consecutiveNaturalStops >= 2) {
          goalState.status = 'verification_passed';
          goalState.reason =
            'model consistently indicated completion via natural stop (no task_complete call)';
          console.log('[GoalLoop] Accepting natural stop after 2 consecutive completions');
          onGoalEvent({ type: 'goal_verification_passed', tokenUsage: totalTokens });
          break;
        }
      } else {
        // Model was cut short (max_turns, blocked) — not a natural stop
        consecutiveNaturalStops = 0;
      }

      // Inject continuation prompt with escalating urgency
      const continueMsg = buildContinuationPrompt(
        goal,
        goalState.turnsCompleted,
        maxTurns,
        isNaturalStop ? consecutiveNaturalStops : 0,
      );
      messages.push({ role: 'user', content: continueMsg });
    }
  }

  // Determine final status if loop exited without explicit status
  if (goalState.status === 'active') {
    if (goalState.turnsCompleted >= maxTurns) {
      goalState.status = 'budget_exhausted';
      goalState.reason = `max goal turns exhausted (${maxTurns})`;
    } else {
      goalState.status = 'blocked';
      goalState.reason = 'goal loop exited without completion';
    }
  }

  onGoalEvent({
    type: 'goal_completed',
    state: { ...goalState },
  });

  const finalMessage: Message = lastResult?.finalMessage ?? {
    role: 'assistant',
    content:
      goalState.status === 'verification_passed'
        ? `目标已完成：${goal.description}`
        : `目标未完成（${goalState.reason || goalState.status}）：${goal.description}`,
  };

  return {
    result: {
      goalRunId,
      state: goalState,
      finalMessage,
      totalTurnCount,
      tokenUsage: totalTokens,
    },
    messages,
  };
}

// ===== Helpers =====

function buildAttemptMessages(
  history: Message[],
  goal: GoalDefinition,
  turnNumber: number,
  lastResult: AgentLoopResult | null,
): Message[] {
  if (turnNumber === 0) {
    // First attempt: use the original goal prompt
    return [...history];
  }

  // Subsequent attempts: history already includes previous results + feedback
  return [...history];
}

function buildVerificationFeedback(
  goal: GoalDefinition,
  verification: VerificationResult,
  turnNumber: number,
  maxTurns: number,
): string {
  const lines = [
    `[目标验证失败 — 第 ${turnNumber}/${maxTurns} 次尝试]`,
    '',
    `验证命令: \`${goal.verificationCommand}\``,
    `退出码: ${verification.exitCode}`,
    '',
  ];

  if (verification.output.trim()) {
    const truncated = verification.output.slice(-3000);
    lines.push('验证输出:');
    lines.push('```');
    lines.push(truncated);
    lines.push('```');
    lines.push('');
  }

  lines.push(`目标: ${goal.description}`);
  if (goal.constraints) {
    lines.push(`约束: ${goal.constraints}`);
  }
  lines.push('');
  lines.push('请根据以上验证失败的输出，继续修复问题。完成后调用 task_complete。');

  return lines.join('\n');
}

function buildContinuationPrompt(
  goal: GoalDefinition,
  turnNumber: number,
  maxTurns: number,
  /** How many times the model has naturally stopped without task_complete (0 = first time or not natural). */
  naturalStopCount?: number,
): string {
  const base = [
    `[目标进行中 — 第 ${turnNumber}/${maxTurns} 次]`,
    '',
    `目标: ${goal.description}`,
    goal.constraints ? `约束: ${goal.constraints}` : '',
    '',
  ];

  // Escalate: if the model already stopped naturally without task_complete,
  // make it crystal clear that task_complete is the REQUIRED exit signal.
  if (naturalStopCount && naturalStopCount > 0) {
    base.push(
      '⚠️ 重要：你上一轮以文本回复结束但没有调用 task_complete 工具。',
      '如果你已经完成了目标，请立即调用 task_complete 工具并提供总结。',
      'task_complete 是唯一能让目标循环正常退出的信号 — 纯文本回复无法退出。',
      '',
      `还剩 ${maxTurns - turnNumber} 次机会。若再次只输出文本而不调 task_complete，将被视为你确认「已完成」并强制结束。`,
    );
  } else {
    base.push('请继续完成目标。如果已完成，请调用 task_complete 并总结完成的内容。');
  }

  return base.join('\n');
}

// ===== Verification =====

interface VerificationResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

const VERIFICATION_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB cap

/**
 * Run a verification command in the working directory.
 * Exit code 0 = passed. Any other exit code or error = failed.
 */
function runVerification(command: string, cwd: string): Promise<VerificationResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      env: { ...process.env },
    });

    let output = '';
    let timedOut = false;

    const cap = (buf: string, chunk: Buffer): string =>
      buf.length >= MAX_OUTPUT_BYTES
        ? buf
        : (buf + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, VERIFICATION_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      output = cap(output, chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      output = cap(output, chunk);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        passed: false,
        exitCode: null,
        output: `${output}\n${String(err)}`,
        timedOut,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        passed: code === 0 && !timedOut,
        exitCode: code,
        output,
        timedOut,
      });
    });
  });
}
