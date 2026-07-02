/**
 * Plan Mode Tools — EnterPlanMode / ExitPlanMode
 *
 * These tools allow the model to voluntarily enter a read-only planning phase,
 * produce a plan file, and request user approval before making changes.
 */

import type { PlanState, ToolResult } from '@shared/types';
import {
  approvePlan,
  enterPlanMode,
  exitPlanMode,
  getPlanState,
  isPlanModeActive,
} from '../agent/plan-mode';
import { BaseTool, obj, p, type Tool } from './types';

// ===== Callbacks =====

export interface PlanToolCallbacks {
  /** Request user approval for a plan. Returns true if approved, false if rejected. */
  onPlanApprovalRequest: (planContent: string, planFilePath: string) => Promise<boolean>;
  /** Get the current working directory. */
  getWorkingDir: () => string;
  /** Get the owning session id for session-scoped agent data. */
  getSessionId?: () => string;
  /** Get the current permission mode. */
  getPermissionMode: () => string;
  /** Get the plan approval behavior for this surface. */
  getPlanApprovalMode?: () => 'interactive' | 'auto_approve' | 'disabled';
}

// ===== EnterPlanMode Tool =====

/**
 * Tool that the model calls to enter plan mode.
 * Saves the current permission mode and switches to read-only.
 */
export function createEnterPlanModeTool(callbacks: PlanToolCallbacks): Tool {
  const tool = new (class extends BaseTool {
    readonly name = 'EnterPlanMode';
    readonly isReadonly = false;
    readonly description =
      'Enter plan mode to explore the codebase and design an implementation plan before making changes. ' +
      'Use this when you need to understand the task before acting. In plan mode, you can only read files ' +
      'and write to the plan file. Call ExitPlanMode when your plan is ready for user approval.';
    readonly parameters = obj({}, []);

    async execute(_params: Record<string, unknown>): Promise<ToolResult> {
      try {
        if (isPlanModeActive()) {
          return this.failure('Already in plan mode. Use ExitPlanMode to exit.');
        }

        if (callbacks.getPlanApprovalMode?.() === 'disabled') {
          return this.failure(
            'Plan mode is disabled for this run. Continue implementing directly with the available permissions.',
          );
        }

        const workingDir = callbacks.getWorkingDir();
        const currentMode = callbacks.getPermissionMode();
        const state = enterPlanMode(
          workingDir,
          currentMode as PlanState['savedPermissionMode'],
          undefined,
          callbacks.getSessionId?.(),
        );

        return this.success(
          `Plan mode activated.\n\n` +
            `**Phase:** Exploring (read-only + plan file writing)\n` +
            `**Plan file:** ${state.planFilePath}\n\n` +
            `Read relevant files, search the codebase, and design your approach. ` +
            `Write your plan to the plan file, then call ExitPlanMode for user approval.`,
        );
      } catch (error) {
        return this.failure(`Failed to enter plan mode: ${error}`);
      }
    }
  })();

  return tool;
}

// ===== ExitPlanMode Tool =====

/**
 * Tool that the model calls to exit plan mode and request user approval.
 * Writes the plan to the plan file and triggers the approval flow.
 */
export function createExitPlanModeTool(callbacks: PlanToolCallbacks): Tool {
  const tool = new (class extends BaseTool {
    readonly name = 'ExitPlanMode';
    readonly isReadonly = false;
    readonly description =
      'Exit plan mode and present your plan for user approval. ' +
      'Provide the complete plan content as the "plan" argument. ' +
      'The plan will be shown to the user for review. If approved, you will regain full tool access. ' +
      'If rejected, you remain in plan mode to revise.';
    readonly parameters = obj(
      {
        plan: p('string', 'The complete plan content to present to the user for approval.'),
      },
      ['plan'],
    );

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      try {
        if (!isPlanModeActive()) {
          return this.failure('Not in plan mode. Use EnterPlanMode first.');
        }

        const state = getPlanState();
        if (!state) {
          return this.failure('Plan state not found.');
        }

        const planContent = params.plan as string;
        if (!planContent || planContent.trim().length === 0) {
          return this.failure(
            'Plan content is required. Provide your complete plan as the "plan" argument.',
          );
        }

        // Write the plan to the plan file
        const fs = await import('node:fs');
        fs.writeFileSync(state.planFilePath, planContent, 'utf-8');

        // Request user approval (this will block until the user responds)
        const approved = await callbacks.onPlanApprovalRequest(planContent, state.planFilePath);

        if (approved) {
          approvePlan();
          const restoredMode = exitPlanMode(true);
          return this.success(
            `Plan approved! Implementation phase begins.\n\n` +
              `**Permission mode restored:** ${restoredMode}\n` +
              `**Plan saved to:** ${state.planFilePath}\n\n` +
              `You now have full tool access. Implement the plan step by step.`,
          );
        }

        exitPlanMode(false);
        return this.failure(
          `Plan was not approved. You remain in plan mode.\n\n` +
            `Review the user's feedback and adjust your approach. ` +
            `Update the plan file and call ExitPlanMode again when ready.`,
        );
      } catch (error) {
        return this.failure(`Failed to exit plan mode: ${error}`);
      }
    }
  })();

  return tool;
}
