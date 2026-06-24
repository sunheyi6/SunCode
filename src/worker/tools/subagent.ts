/**
 * Subagent tool — allows the main agent to delegate tasks to specialized sub-agents.
 *
 * Supports two calling conventions:
 *   1. Single call:  { agent: "explore", prompt: "..." }
 *   2. Parallel:     { calls: [{ agent: "explore", prompt: "..." }, ...] }
 * Both produce identical behavior — the single form is auto-wrapped into calls[0].
 */
import type { SubagentCall, ToolDefinition, ToolResult } from '@shared/types';
import type { Tool } from './types';
import type { SubagentDispatcher } from '../agent/subagent';

export function createSubagentTool(dispatcher: SubagentDispatcher): Tool {
  const agentList = dispatcher.listAgents();

  const callItemSchema = {
    type: 'object' as const,
    properties: {
      agent: {
        type: 'string' as const,
        description: `子 Agent 名称。可用: ${agentList.join(', ')}`,
        enum: agentList.length > 0 ? agentList : undefined,
      },
      prompt: {
        type: 'string' as const,
        description: '发送给子 Agent 的任务描述。应自包含所有必要的上下文，因为子 Agent 默认看不到父对话历史。',
      },
      session: {
        type: 'string' as const,
        description: '可选。持久化会话标识。相同标识共享上下文。用于多轮交互的长期任务。',
      },
      initialContext: {
        type: 'string' as const,
        enum: ['empty', 'parent'],
        description: '初始上下文。empty（默认）：只含任务描述。parent：包含父对话快照。',
      },
    },
    required: ['agent', 'prompt'],
  };

  return {
    name: 'subagent',
    description: `委托任务给专项子 Agent（可用: ${agentList.join(', ')}）。将独立的探索、审查或实现任务交给专项 Agent 并行执行，避免主对话上下文污染。调用方式：单个调用传 agent+prompt，并行调用传 calls 数组。`,

    parameters: {
      type: 'object',
      properties: {
        // Single-call mode (simpler, what LLMs naturally do)
        agent: {
          type: 'string' as const,
          description: `子 Agent 名称（单次调用）。可用: ${agentList.join(', ')}。与 calls 互斥。`,
          enum: agentList.length > 0 ? agentList : undefined,
        },
        prompt: {
          type: 'string' as const,
          description: '任务描述（单次调用）。与 calls 互斥。',
        },
        session: {
          type: 'string' as const,
          description: '可选。持久化会话标识。',
        },
        initialContext: {
          type: 'string' as const,
          enum: ['empty', 'parent'],
          description: '初始上下文。',
        },
        // Batch mode (parallel calls)
        calls: {
          type: 'array' as const,
          description: '批量并行调用。包含多个 { agent, prompt } 对象。与 agent/prompt 互斥。',
          items: callItemSchema,
        },
      },
      // No top-level required — validate in execute()
    } as ToolDefinition['parameters'],

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      console.log('[Subagent] execute() called with params keys:', Object.keys(params));
      // Normalize to calls[] array
      let calls: SubagentCall[];

      if (params.calls && Array.isArray(params.calls) && (params.calls as unknown[]).length > 0) {
        // Batch mode
        calls = params.calls as SubagentCall[];
        console.log('[Subagent] Batch mode: got', calls.length, 'calls');
      } else if (params.agent && params.prompt) {
        // Single-call mode — wrap into calls array
        calls = [
          {
            agent: params.agent as string,
            prompt: params.prompt as string,
            session: params.session as string | undefined,
            initialContext: (params.initialContext as 'empty' | 'parent') || undefined,
          },
        ];
        console.log('[Subagent] Single-call mode: agent=', params.agent, 'prompt=', (params.prompt as string).slice(0, 50));
      } else {
        const hint = agentList.length > 0
          ? `用法: { agent: "${agentList[0]}", prompt: "任务描述" } 或 { calls: [{ agent: "...", prompt: "..." }] }`
          : '没有可用的子 Agent。请在 .suncode/agents/ 下创建 agent 定义。';
        console.log('[Subagent] ERROR: no agent+prompt or calls found. Params:', JSON.stringify(params).slice(0, 200));
        return {
          toolCallId: '',
          name: 'subagent',
          success: false,
          output: '',
          error: `参数错误。${hint}`,
        };
      }

      // Validate each call
      for (const call of calls) {
        if (!call.agent || !call.prompt) {
          return {
            toolCallId: '',
            name: 'subagent',
            success: false,
            output: '',
            error: '每个调用必须包含 agent 和 prompt 字段',
          };
        }
        if (!dispatcher.getDefinition(call.agent)) {
          const available = dispatcher.listAgents().join(', ');
          console.log('[Subagent] ERROR: unknown agent:', call.agent, 'available:', available);
          return {
            toolCallId: '',
            name: 'subagent',
            success: false,
            output: '',
            error: `未知的 Agent: "${call.agent}"。可用: ${available}`,
          };
        }
      }

      console.log('[Subagent] Dispatching', calls.length, 'calls...');
      const results = await dispatcher.dispatch(calls);
      console.log('[Subagent] Dispatch complete:', results.map(r => `${r.agent}: ${r.success ? 'OK' : r.error} think=${r.thinking?.length ?? 0} calls=${r.internalCalls?.length ?? 0}`));
      const succeeded = results.filter((r) => r.success).length;

      const output = [
        `${succeeded}/${results.length} 子 Agent 成功完成`,
        '',
        ...results.map((r, i) => {
          const header = `[${i + 1}: ${r.agent}${r.session ? ` session=${r.session}` : ''}]`;
          if (r.success) {
            const usage = `(tokens: ${r.tokenUsage.total}, 工具调用: ${r.toolCalls})`;
            return `${header} 完成 ${usage}:\n${r.output}`;
          }
          return `${header} 失败:\n${r.error}`;
        }),
      ].join('\n');

      const toolResult = {
        toolCallId: '',
        name: 'subagent',
        success: succeeded > 0,
        output,
        error: succeeded === 0 ? '所有子 Agent 均执行失败' : undefined,
        subagentResults: results,
      };
      console.log('[Subagent] ToolResult has subagentResults:', toolResult.subagentResults.length, 'items');
      return toolResult;
    },

    getDefinition(): ToolDefinition {
      return { name: this.name, description: this.description, parameters: this.parameters };
    },
  };
}
