/**
 * Plan Mode State Machine
 *
 * Two-phase design:
 *   1. exploring — read-only tools + plan file writing, no destructive operations
 *   2. implementing — full permissions restored after user approval
 *
 * The agent voluntarily reduces its own permissions to gain user trust.
 * This is the only mechanism where the model actively requests LESS capability.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_PLAN_DIR, DEFAULT_PLAN_MAX_TURNS } from '@shared/constants';
import type { AppSettings, PlanState } from '@shared/types';

// ===== Plan Mode State =====

let planState: PlanState | null = null;

/** Get the current plan mode state, or null if not in plan mode. */
export function getPlanState(): PlanState | null {
  return planState;
}

/** Check whether plan mode is active. */
export function isPlanModeActive(): boolean {
  return planState !== null;
}

/** Check whether currently in the exploring phase. */
export function isExploring(): boolean {
  return planState?.phase === 'exploring';
}

/** Check whether currently in the implementing phase. */
export function isImplementing(): boolean {
  return planState?.phase === 'implementing';
}

/**
 * Enter plan mode — save current permission mode and switch to read-only.
 * Only callable when NOT already in plan mode.
 */
export function enterPlanMode(
  workingDir: string,
  currentPermissionMode: AppSettings['permissionMode'],
  maxTurns: number = DEFAULT_PLAN_MAX_TURNS,
): PlanState {
  if (planState) {
    throw new Error('Already in plan mode');
  }

  const planDir = path.join(workingDir, DEFAULT_PLAN_DIR);
  fs.mkdirSync(planDir, { recursive: true });

  const slug = generatePlanSlug();
  const planFilePath = path.join(planDir, `${slug}.md`);

  planState = {
    phase: 'exploring',
    savedPermissionMode: currentPermissionMode,
    planFilePath,
    planTurnCount: 0,
    maxTurns,
  };

  return planState;
}

/**
 * Exit plan mode. Restores the saved permission mode.
 * If a circuit breaker was triggered (auto-mode disabled during plan mode),
 * fall back to safe defaults.
 */
export function exitPlanMode(wasApproved: boolean): PlanState['savedPermissionMode'] {
  if (!planState) {
    throw new Error('Not in plan mode');
  }

  const restoredMode = planState.savedPermissionMode;
  if (!wasApproved) {
    planState.phase = 'exploring';
    planState.approved = false;
    return 'plan';
  }

  planState = null;
  return restoredMode;
}

/**
 * Transition from exploring to implementing phase.
 * Called after user approves the plan.
 */
export function approvePlan(): void {
  if (!planState) return;
  planState.phase = 'implementing';
  planState.approved = true;
}

/**
 * Get the effective permission mode while in plan mode.
 * During exploring: plan (read-only + plan file write).
 * During implementing: restored permission mode.
 */
export function getPlanPermissionMode(): AppSettings['permissionMode'] | null {
  if (!planState) return null;
  if (planState.phase === 'exploring') return 'plan';
  return planState.savedPermissionMode;
}

/**
 * Check if a tool is allowed during the exploring phase.
 * Exploring allows only read-only tools + write to the plan file.
 */
export function isToolAllowedInPlanMode(
  toolName: string,
  params: Record<string, unknown>,
): boolean {
  if (planState?.phase !== 'exploring') return true;

  if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') return true;

  // Read-only tools are always allowed
  const readOnlyTools = ['read', 'grep', 'glob', 'ls', 'find', 'web_search', 'web_fetch'];
  if (readOnlyTools.includes(toolName)) return true;

  // Allow writing only to the plan file
  if (toolName === 'write' || toolName === 'edit') {
    const filePath = (params.file_path || params.filePath || '') as string;
    const normalized = path.normalize(filePath);
    const planFileNormalized = path.normalize(planState.planFilePath);
    if (normalized === planFileNormalized) return true;
  }

  return false;
}

/**
 * Check if the plan mode should be reminded to the model.
 * Uses progressive prompt injection to save tokens:
 *   Turn 1: full instructions
 *   Turn 2-4: silent
 *   Turn 5: sparse reminder
 *   At 60% of maxTurns: warning with remaining turns
 *   At 80%+ of maxTurns: urgent warning every turn
 *   Every 25 turns: full refresh
 */
export function getPlanModeReminder(turnCount: number): string | null {
  if (planState?.phase !== 'exploring') return null;

  const { planTurnCount, maxTurns } = planState;
  const ratio = planTurnCount / maxTurns;

  if (ratio >= 1.0) return PLAN_MODE_FORCE_EXIT;

  if (ratio >= 0.8) {
    const remaining = maxTurns - planTurnCount;
    return PLAN_MODE_URGENT(remaining);
  }

  if (ratio >= 0.6) {
    const remaining = maxTurns - planTurnCount;
    return PLAN_MODE_WARNING(remaining);
  }

  if (turnCount === 1) return PLAN_MODE_FULL_INSTRUCTIONS;
  if (turnCount === 5) return PLAN_MODE_SPARSE_REMINDER;
  if (turnCount % 25 === 0) return PLAN_MODE_FULL_INSTRUCTIONS;
  return null;
}

/**
 * Increment the plan mode turn counter.
 * Returns true if the max turns limit has been exceeded.
 */
export function incrementPlanTurn(): boolean {
  if (!planState) return false;
  planState.planTurnCount++;
  return planState.planTurnCount > planState.maxTurns;
}

/**
 * Check whether plan mode has exceeded its turn limit and must exit.
 */
export function isPlanMaxTurnsExceeded(): boolean {
  if (!planState) return false;
  return planState.planTurnCount > planState.maxTurns;
}

/**
 * Force-exit plan mode due to turn limit exceeded.
 * Approves the plan automatically and restores permissions.
 */
export function forceExitPlanMode(): PlanState['savedPermissionMode'] {
  if (!planState) {
    throw new Error('Not in plan mode');
  }
  const restoredMode = planState.savedPermissionMode;
  planState = null;
  return restoredMode;
}

/**
 * Build plan mode instructions for the system prompt.
 * Only included when plan mode is active.
 */
export function buildPlanModeInstructions(planState: PlanState, turnCount: number): string {
  const reminder = getPlanModeReminder(turnCount);
  const base = `
## Plan Mode (Active)
You are currently in **plan mode**. You voluntarily reduced your permissions to read-only
(except for writing the plan file) to build user trust before making changes.

**Phase: ${planState.phase === 'exploring' ? 'Exploration & Planning' : 'Implementation'}**

- Plan file: \`${planState.planFilePath}\`
- Only READ tools + writing the plan file are allowed in exploration phase.
- Use EnterPlanMode and ExitPlanMode tools to manage transitions.
- Do NOT make any file modifications outside the plan file until the user approves your plan.
`;

  if (reminder) {
    return `${base}\n${reminder}`;
  }
  return base;
}

// ===== Helpers =====

const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
  'quebec',
  'romeo',
  'sierra',
  'tango',
  'uniform',
  'victor',
  'whiskey',
  'xray',
  'yankee',
  'zulu',
  'eagle',
  'falcon',
  'hawk',
  'owl',
  'raven',
  'swift',
  'badger',
  'otter',
  'panda',
  'koala',
  'tiger',
  'wolf',
  'bear',
  'deer',
  'coral',
  'crystal',
  'ember',
  'flint',
  'glacier',
  'horizon',
  'island',
  'jasper',
  'krypton',
  'lagoon',
  'meadow',
  'nebula',
  'oasis',
  'prism',
  'quartz',
  'reef',
  'aurora',
  'breeze',
  'comet',
  'dawn',
  'eclipse',
  'frost',
  'gale',
  'harbor',
  'iris',
  'jade',
  'kiwi',
  'lotus',
  'maple',
  'nova',
  'opal',
  'pine',
];

function generatePlanSlug(): string {
  const word1 = WORDS[Math.floor(Math.random() * WORDS.length)];
  const word2 = WORDS[Math.floor(Math.random() * WORDS.length)];
  const num = Math.floor(Math.random() * 100);
  return `${word1}-${word2}-${num}`;
}

// ===== Plan Mode Prompt Templates =====

function PLAN_MODE_WARNING(remaining: number): string {
  return `**⚠️ Plan mode turn limit approaching:** ${remaining} turns remaining before automatic exit.
Speed up your exploration — focus on the key files needed to form a plan.
Write your plan and call ExitPlanMode soon.`;
}

function PLAN_MODE_URGENT(remaining: number): string {
  return `**🚨 URGENT: Plan mode about to time out!** Only ${remaining} turn${remaining === 1 ? '' : 's'} left.
Write your plan to the plan file NOW and call ExitPlanMode immediately.
Do NOT read more files — synthesize what you know.`;
}

const PLAN_MODE_FORCE_EXIT = `**🛑 Plan mode turn limit EXCEEDED.**
You have spent too many turns exploring. The system will automatically approve your
partial plan and switch to implementation mode. Write whatever plan you have to the
plan file NOW and call ExitPlanMode in this same turn.`;

const PLAN_MODE_FULL_INSTRUCTIONS = `## Plan Mode — Full Instructions

You are in **exploration phase**. Your goal is to understand the task thoroughly
and produce a clear, actionable plan before making any changes.

**Workflow:**
1. Read relevant files to understand the current state
2. Search for patterns, dependencies, and affected areas
3. Design an approach considering trade-offs
4. Write your plan to the plan file (use \`write\` tool targeting the plan file path)
5. When ready, call \`ExitPlanMode\` to present your plan for user approval

**Plan file format:**
- Use clear section headers: ## Problem, ## Approach, ## Files to Change, ## Steps
- Be specific about what changes you'll make and why
- Include edge cases and risks you've considered

**Important:** Do NOT make any changes to project files until the user approves your plan.`;

const PLAN_MODE_SPARSE_REMINDER = `**Reminder:** You are still in plan mode (read-only). Write your plan to the plan file, then call ExitPlanMode.`;
