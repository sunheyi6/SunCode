/**
 * Streaming Tool Pre-Executor
 *
 * Executes read-only tools during LLM streaming — as soon as a tool_use
 * JSON block is complete, execution begins without waiting for the full
 * API response. This hides ~1s tool latency behind the model's 5-30s
 * generation window.
 *
 * Key design:
 * - Read-only tools start immediately (parallel)
 * - Write tools are deferred until after streaming completes
 * - Permission checks still apply for confirm_changes mode
 * - Results are collected and returned alongside the stream output
 */

import type { RunEvent, RunId, ToolCallContent, ToolResult, PreExecutedToolCall } from '@shared/types';
import type { Tool } from '../tools/types';

// ===== Tool Execution Callbacks =====

export interface StreamingExecutorCallbacks {
  runId?: RunId;
  onToolStart?: (toolCall: ToolCallContent) => void;
  onToolEnd?: (result: ToolResult) => void;
  onToolProgress?: (toolCallId: string, output: string) => void;
  onRunEvent?: (event: RunEvent) => void;
}

// ===== StreamingToolExecutor =====

export class StreamingToolExecutor {
  private tools: Map<string, Tool>;
  private running: Map<string, Promise<ToolResult>> = new Map();
  private results: Map<string, ToolResult> = new Map();
  private callbacks: StreamingExecutorCallbacks;
  private workingDir: string;
  /** Tool calls that require confirmation before execution. */
  private deferredCalls: ToolCallContent[] = [];
  /** Whether confirm_changes permission mode is active. */
  private confirmMode: boolean;

  constructor(
    tools: Tool[],
    workingDir: string,
    confirmMode: boolean,
    callbacks: StreamingExecutorCallbacks = {},
  ) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.workingDir = workingDir;
    this.confirmMode = confirmMode;
    this.callbacks = callbacks;
  }

  /**
   * Called when a tool_use block is complete during streaming.
   * Read-only tools start immediately; write tools are deferred.
   */
  onToolCallComplete(toolCall: ToolCallContent): void {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      this.results.set(toolCall.id, {
        toolCallId: toolCall.id,
        name: toolCall.name,
        success: false,
        output: '',
        error: `未知工具: ${toolCall.name}`,
      });
      return;
    }

    // Read-only tools can execute immediately
    // Write tools are deferred if in confirm_changes mode
    const needsConfirmation = this.confirmMode && !tool.isReadonly;

    if (needsConfirmation) {
      // Defer execution until after streaming completes
      this.deferredCalls.push(toolCall);
      return;
    }

    // Start execution immediately
    this.startExecution(toolCall, tool);
  }

  private startExecution(toolCall: ToolCallContent, tool: Tool): void {
    tool.onProgress = (chunk: string) => {
      this.callbacks.onToolProgress?.(toolCall.id, chunk);
    };

    this.callbacks.onToolStart?.(toolCall);
    this.callbacks.onRunEvent?.({
      type: 'tool_started',
      runId: this.callbacks.runId ?? '',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      timestamp: '',
      arguments: toolCall.arguments,
      description: toolCall.name,
    });

    const promise = this.executeTool(tool, toolCall)
      .then((result) => {
        result.toolCallId = toolCall.id;
        this.results.set(toolCall.id, result);
        tool.onProgress = null;
        this.callbacks.onToolEnd?.(result);
        this.emitCompleted(toolCall, result);
        return result;
      })
      .catch((err) => {
        const result: ToolResult = {
          toolCallId: toolCall.id,
          name: toolCall.name,
          success: false,
          output: '',
          error: (err as Error).message,
        };
        this.results.set(toolCall.id, result);
        tool.onProgress = null;
        this.callbacks.onToolEnd?.(result);
        this.emitCompleted(toolCall, result);
        return result;
      });

    this.running.set(toolCall.id, promise);
  }

  private emitCompleted(toolCall: ToolCallContent, result: ToolResult): void {
    this.callbacks.onRunEvent?.({
      type: 'tool_completed',
      runId: this.callbacks.runId ?? '',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      success: result.success,
      timestamp: '',
      output: result.output?.slice(0, 2000),
      error: result.error ? result.error.slice(0, 500) : undefined,
      message: `${result.success ? 'OK' : 'FAIL'}: ${toolCall.name}`,
    });
  }

  private async executeTool(tool: Tool, toolCall: ToolCallContent): Promise<ToolResult> {
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(toolCall.arguments);
    } catch {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        success: false,
        output: '',
        error: '工具参数解析失败',
      };
    }

    return tool.execute(params);
  }

  /**
   * Execute all deferred (write) tool calls.
   * Called after streaming completes.
   */
  async executeDeferred(): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const toolCall of this.deferredCalls) {
      const tool = this.tools.get(toolCall.name);
      if (!tool) continue;
      this.startExecution(toolCall, tool);
    }

    // Wait for all deferred executions
    const promises = this.deferredCalls.map((tc) => this.running.get(tc.id));
    await Promise.allSettled(promises);

    // Collect results
    for (const toolCall of this.deferredCalls) {
      const result = this.results.get(toolCall.id);
      if (result) results.push(result);
    }

    return results;
  }

  /**
   * Wait for all pre-executed tools to complete and collect results.
   * Called after streaming completes.
   */
  async collectAllResults(): Promise<ToolResult[]> {
    // Wait for all running executions
    const promises = Array.from(this.running.values());
    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }

    // Collect results in order of tool calls
    const results: ToolResult[] = [];
    for (const [id, result] of this.results) {
      results.push(result);
    }

    return results;
  }

  /**
   * Get results for specific tool call IDs (maintains original order).
   */
  getResultsFor(toolCallIds: string[]): ToolResult[] {
    return toolCallIds
      .map((id) => this.results.get(id))
      .filter((r): r is ToolResult => r !== undefined);
  }

  /** Number of tools currently executing. */
  get runningCount(): number {
    return this.running.size;
  }
}

// ===== Helper =====

/**
 * Classify tool calls into read-only (can pre-execute) and write (deferred).
 */
export function classifyToolCalls(
  toolCalls: ToolCallContent[],
  tools: Tool[],
): { preExecutable: ToolCallContent[]; deferred: ToolCallContent[] } {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const preExecutable: ToolCallContent[] = [];
  const deferred: ToolCallContent[] = [];

  for (const tc of toolCalls) {
    const tool = toolMap.get(tc.name);
    if (tool?.isReadonly) {
      preExecutable.push(tc);
    } else {
      deferred.push(tc);
    }
  }

  return { preExecutable, deferred };
}
