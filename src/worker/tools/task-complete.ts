import { BaseTool, p, obj } from './types';

/** Name of the task-complete signal tool. The agent loop checks for this
 *  tool name to stop early instead of continuing to the next turn. */
export const TASK_COMPLETE_TOOL_NAME = 'task_complete';

export function createTaskCompleteTool() {
  return new (class TaskCompleteTool extends BaseTool {
    readonly name = TASK_COMPLETE_TOOL_NAME;
    readonly description =
      "Signal that the task is completely finished. Call this as the FINAL action ONLY after you have FULLY completed AND verified the user's request. Provide a concise summary of what was accomplished, including evidence that your work is correct (e.g., test output, run results). Do NOT call this together with other tools. Do NOT call this if your code hasn't been tested and confirmed working — untested code is not done.";
    readonly parameters = obj(
      {
        summary: p(
          'string',
          "A one-paragraph summary in the user's language describing what was done and why. Be specific — mention files changed, commands run, and decisions made.",
        ),
      },
      ['summary'],
    );

    async execute(params: Record<string, unknown>): Promise<ReturnType<BaseTool['execute']>> {
      // This tool is a signal, not an action. The agent loop intercepts
      // it before execution and stops the loop. If somehow reached, just
      // return success — the caller (agent loop) will handle the stop.
      const summary = (params.summary as string) || 'Task completed.';
      return this.success(summary);
    }
  })();
}
