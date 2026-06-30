import type { ToolCallContent, ToolResult, RunEvent, AppSettings } from '@shared/types';
import type { DiagLogger } from '../utils/diag-logger';
import type { Tool } from '../tools/types';
import { quickMatchLesson } from './lessons';

function parseToolDescriptionArgs(argumentsJson: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function buildToolDescription(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return name;

  const safeArgs = { ...args };
  const redacted = new Set([
    'content',
    'new_string',
    'old_string',
    'output',
    'stdout',
    'text',
    'thinking',
  ]);

  for (const key of Object.keys(safeArgs)) {
    if (redacted.has(key) && typeof safeArgs[key] === 'string') {
      safeArgs[key] = `[${safeArgs[key].length} chars]`;
    }
  }

  const keyArgs = Object.entries(safeArgs)
    .filter(([, value]) => value !== undefined && value !== null)
    .slice(0, 3)
    .map(([key, value]) => {
      if (typeof value !== 'string') return `${key}=${JSON.stringify(value)}`;
      return `${key}=${value.length > 60 ? `${value.slice(0, 57)}...` : value}`;
    })
    .join(', ');

  return keyArgs ? `${name}(${keyArgs})` : name;
}

function toolResultMeta(result: ToolResult, rawOutputLen: number): {
  truncated: boolean | undefined;
  message: string;
} {
  const truncated = rawOutputLen > 2000 || result.output.length < rawOutputLen;
  const status = result.success ? 'OK' : 'FAIL';
  const errorNote = result.error ? ` - ${result.error.slice(0, 80)}` : '';
  const truncNote = truncated ? ` (truncated from ${rawOutputLen} chars)` : '';

  return {
    truncated: truncated ? true : undefined,
    message: `${status}: ${result.name}${errorNote}${truncNote}`,
  };
}

export interface ExecuteToolsInput {
  toolCalls: ToolCallContent[];
  tools: Tool[];
  settings: AppSettings;
  workingDir: string;
  runId: string;
  onToolStart: (tc: ToolCallContent) => void;
  onToolEnd: (result: ToolResult) => void;
  onToolProgress: (toolCallId: string, chunk: string) => void;
  onRunEvent: (event: RunEvent) => void;
  diag: DiagLogger;
  requestConfirmation?: (tc: ToolCallContent) => Promise<boolean>;
}

export interface ExecuteToolsOutput {
  results: ToolResult[];
}

export async function executeTools(input: ExecuteToolsInput): Promise<ExecuteToolsOutput> {
  const {
    toolCalls,
    tools,
    settings,
    workingDir,
    runId,
    onToolStart,
    onToolEnd,
    onToolProgress,
    onRunEvent,
    diag,
    requestConfirmation,
  } = input;

  console.log(`[AgentLoop] Executing ${toolCalls.length} tool calls`);

  const toolResults: ToolResult[] = [];
  const toExecute: { tc: ToolCallContent; tool: Tool; params: Record<string, unknown> }[] = [];

  for (const tc of toolCalls) {
    const description = buildToolDescription(tc.name, parseToolDescriptionArgs(tc.arguments));
    onToolStart(tc);
    onRunEvent({
      type: 'tool_started',
      runId,
      toolCallId: tc.id,
      toolName: tc.name,
      timestamp: '',
      arguments: tc.arguments,
      description,
    });

    const tool = tools.find((t) => t.name === tc.name);
    if (!tool) {
      const e: ToolResult = {
        toolCallId: tc.id,
        name: tc.name,
        success: false,
        error: `未知工具: ${tc.name}`,
        output: '',
      };
      toolResults.push(e);
      onToolEnd(e);
      onRunEvent({
        type: 'tool_completed',
        runId,
        toolCallId: tc.id,
        toolName: tc.name,
        success: false,
        timestamp: '',
        error: `未知工具: ${tc.name}`,
        output: '',
      });
      console.warn(`[AgentLoop] Unknown tool: ${tc.name}`);
      continue;
    }

    let params: Record<string, unknown>;
    try {
      params = JSON.parse(tc.arguments);
    } catch {
      const e: ToolResult = {
        toolCallId: tc.id,
        name: tc.name,
        success: false,
        error: `Validation failed for tool "${tc.name}": JSON parse error in arguments.\n\nReceived arguments:\n${tc.arguments}`,
        output: '',
      };
      toolResults.push(e);
      onToolEnd(e);
      onRunEvent({
        type: 'tool_completed',
        runId,
        toolCallId: tc.id,
        toolName: tc.name,
        success: false,
        timestamp: '',
        error: e.error,
        output: '',
      });
      continue;
    }

    {
      const def = tool.getDefinition();
      const required = (def.parameters as { required?: string[] }).required ?? [];
      const props =
        (def.parameters as { properties?: Record<string, { type: string }> }).properties ?? {};
      let missing: string | null = null;
      for (const key of required) {
        if (params[key] === undefined || params[key] === null) {
          missing = key;
          break;
        }
        if (props[key]?.type === 'integer' && typeof params[key] === 'string') {
          const n = Number(params[key]);
          if (Number.isFinite(n)) params[key] = n;
        }
      }
      if (missing) {
        const formatted = `Validation failed for tool "${tc.name}":\n  - ${missing}: Required property\n\nReceived arguments:\n${JSON.stringify(params, null, 2)}`;
        const e: ToolResult = {
          toolCallId: tc.id,
          name: tc.name,
          success: false,
          error: formatted,
          output: '',
        };
        toolResults.push(e);
        onToolEnd(e);
        onRunEvent({
          type: 'tool_completed',
          runId,
          toolCallId: tc.id,
          toolName: tc.name,
          success: false,
          timestamp: '',
          error: formatted,
          output: '',
        });
        continue;
      }
    }

    if (
      settings.permissionMode === 'confirm_changes' &&
      !tool.isReadonly &&
      requestConfirmation
    ) {
      const confirmed = await requestConfirmation(tc);
      if (!confirmed) {
        const skipped: ToolResult = {
          toolCallId: tc.id,
          name: tc.name,
          success: false,
          error: '用户取消了此操作',
          output: '',
        };
        toolResults.push(skipped);
        onToolEnd(skipped);
        onRunEvent({
          type: 'tool_completed',
          runId,
          toolCallId: tc.id,
          toolName: tc.name,
          success: false,
          timestamp: '',
          error: '用户取消了此操作',
          output: '',
        });
        continue;
      }
    }

    toExecute.push({ tc, tool, params });
  }

  if (toExecute.length > 0) {
    const mode = toExecute.length > 1 ? 'parallel' : 'single';
    const toolExecStartTime = Date.now();
    console.log(
      `[AgentLoop] Executing ${toExecute.length} tools in ${mode}:` +
        ` [${toExecute.map((t) => t.tc.name).join(', ')}]`,
    );

    const settled = await Promise.allSettled(
      toExecute.map(async ({ tc, tool, params }) => {
        const tStart = Date.now();
        try {
          const paramsStr = JSON.stringify(params);
          const paramsPreview =
            paramsStr.length > 100 ? `${paramsStr.slice(0, 100)}...` : paramsStr;
          console.log(`[AgentLoop] Tool ${tc.name} executing (params: ${paramsPreview})`);
          tool.onProgress = (chunk: string) => onToolProgress(tc.id, chunk);
          const result = await tool.execute(params);
          tool.onProgress = null;
          result.toolCallId = tc.id;
          onToolEnd(result);
          const rawOutputLen = result.output.length;
          const meta = toolResultMeta(result, rawOutputLen);
          onRunEvent({
            type: 'tool_completed',
            runId,
            toolCallId: tc.id,
            toolName: tc.name,
            success: result.success,
            timestamp: '',
            output: result.output?.slice(0, 2000),
            error: result.error ? result.error.slice(0, 500) : undefined,
            truncated: meta.truncated,
            message: meta.message,
          });
          console.log(
            `[AgentLoop] Tool ${tc.name}: ${result.success ? 'OK' : 'FAIL'}` +
              ` (${Date.now() - tStart}ms)` +
              `${result.error ? ` — ${result.error.slice(0, 80)}` : ''}`,
          );
          diag.log('TOOL', `${tc.name} ${result.success ? 'OK' : 'FAIL'}`, {
            durationMs: Date.now() - tStart,
            success: result.success,
            arguments: tc.arguments.slice(0, 500),
            outputPreview: result.output?.slice(0, 500),
            ...(result.error ? { error: result.error.slice(0, 80) } : {}),
          });
          return result;
        } catch (error) {
          const e: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            success: false,
            error: (error as Error).message,
            output: '',
          };
          onToolEnd(e);
          onRunEvent({
            type: 'tool_completed',
            runId,
            toolCallId: tc.id,
            toolName: tc.name,
            success: false,
            timestamp: '',
            error: e.error?.slice(0, 500) || '',
            output: '',
          });
          console.log(
            `[AgentLoop] Tool ${tc.name}: CRASH (${Date.now() - tStart}ms) — ${(error as Error).message.slice(0, 80)}`,
          );
          diag.log('TOOL', `${tc.name} CRASH`, {
            durationMs: Date.now() - tStart,
            arguments: tc.arguments.slice(0, 500),
            error: (error as Error).message.slice(0, 80),
          });
          return e;
        }
      }),
    );

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        toolResults.push(s.value);
      } else {
        toolResults.push({
          toolCallId: '',
          name: 'unknown',
          success: false,
          error: `内部错误: ${s.reason}`,
          output: '',
        });
      }
    }

    console.log(
      `[AgentLoop] Tools done: ${toolResults.filter((t) => t.success).length}/${toolResults.length} OK` +
        ` (total ${Date.now() - toolExecStartTime}ms)`,
    );
    diag.exit(
      'TOOLS',
      `${toolResults.filter((t) => t.success).length}/${toolResults.length} OK`,
      { durationMs: Date.now() - toolExecStartTime },
    );

    for (const tr of toolResults) {
      if (!tr.success && tr.error) {
        try {
          const match = quickMatchLesson(workingDir, tr.name, tr.error);
          if (match) {
            tr.output = `⚠️ 相关教训：[${match.entry.date}] ${match.entry.title}
   使用 search_lessons 工具查看详情。

${tr.output}`;
          }
        } catch {
          // Never let lesson matching break tool execution
        }
      }
    }
  }

  return { results: toolResults };
}
