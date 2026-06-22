import { MAX_TURNS } from '@shared/constants';
import type { AppSettings, Message, StreamEvent, ToolCallContent, ToolResult } from '@shared/types';
import type { Tool } from '../tools/types';
import { buildSystemPrompt } from './system-prompt';

export interface AgentLoopInput {
  model: unknown; // pi-ai Model type
  messages: Message[];
  tools: Tool[];
  settings: AppSettings;
  workingDir: string;
  skillsContent: string;
  /** Content from .agents.md (Codex convention) */
  agentsMdContent?: string;
  abortSignal: AbortSignal;
  onStream: (event: StreamEvent) => void;
  onToolStart: (toolCall: ToolCallContent) => void;
  onToolEnd: (result: ToolResult) => void;
  initialTurnCount: number;
}

export interface AgentLoopResult {
  finalMessage: Message;
  turnCount: number;
  tokenUsage: { input: number; output: number; total: number };
}

interface PiAssistantMessage {
  role: string;
  content: unknown;
  stopReason?: string;
  errorMessage?: string;
}

type CompleteSimple = (
  model: unknown,
  context: Record<string, unknown>,
) => Promise<PiAssistantMessage>;

/**
 * Core agent loop: prompt → LLM stream → tool execution → repeat.
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const {
    model,
    messages: initialMessages,
    tools,
    settings,
    workingDir,
    skillsContent,
    agentsMdContent,
    abortSignal,
    onStream,
    onToolStart,
    onToolEnd,
    initialTurnCount,
  } = input;

  if (!model) {
    throw new Error('未配置模型。请在设置中选择一个模型并配置 API Key。');
  }

  const contextMessages: Message[] = [...initialMessages];
  let turnCount = initialTurnCount;
  const tokenUsage = { input: 0, output: 0, total: 0 };
  const completedToolCalls: ToolCallContent[] = [];

  const identityReply = getIdentityReply(initialMessages);
  if (identityReply) {
    onStream({ type: 'text_delta', text: identityReply });
    onStream({ type: 'text_end' });
    return {
      finalMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: identityReply }],
        toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
      },
      turnCount: initialTurnCount + 1,
      tokenUsage,
    };
  }

  // Build tool definitions for the LLM
  const toolDefs = tools.map((t) => t.getDefinition());

  // Build system prompt
  const systemPrompt = buildSystemPrompt({
    workingDir,
    tools: toolDefs,
    skillsContent,
    maxTurns: settings.maxTurns,
    agentsMdContent,
  });

  // Prepend system message
  contextMessages.unshift({ role: 'system', content: systemPrompt });

  console.log(
    `[AgentLoop] Starting with model=${settings.activeProvider}/${settings.activeModel}, tools=${tools.length}`,
  );

  // Main loop
  while (turnCount < (settings.maxTurns || MAX_TURNS)) {
    if (abortSignal.aborted) {
      const err = new Error('已中止') as Error & { name: string };
      err.name = 'AbortError';
      throw err;
    }

    turnCount++;
    console.log(`[AgentLoop] Turn ${turnCount}/${settings.maxTurns}`);

    try {
      // Import pi-ai dynamically
      let completeSimple: CompleteSimple;
      try {
        const pi = await import('@earendil-works/pi-ai');
        completeSimple = pi.completeSimple as unknown as CompleteSimple;
        if (!completeSimple) {
          throw new Error('completeSimple not found in pi-ai exports');
        }
      } catch (importErr) {
        console.error('[AgentLoop] Failed to import pi-ai:', importErr);
        throw new Error(
          `无法加载 AI 库：${(importErr as Error).message}。请确保已安装 @earendil-works/pi-ai。`,
        );
      }

      // Build context for pi-ai
      const piContext = {
        system: systemPrompt,
        messages: contextMessages.filter((m) => m.role !== 'system').map(convertMessage),
        tools: toolDefs.map(convertToolDef),
      };

      console.log(`[AgentLoop] Calling completeSimple with ${piContext.messages.length} messages`);

      // Call the LLM
      const assistantMsg = await completeSimple(model, piContext);

      console.log(`[AgentLoop] Got response:`, {
        role: assistantMsg.role,
        contentLength:
          typeof assistantMsg.content === 'string'
            ? assistantMsg.content.length
            : (assistantMsg.content as unknown[])?.length,
        stopReason: assistantMsg.stopReason,
      });

      if (assistantMsg.stopReason === 'error') {
        throw new Error(
          assistantMsg.errorMessage ||
            `模型 ${settings.activeProvider}/${settings.activeModel} 请求失败，请检查 API Key 和网络连接。`,
        );
      }

      // Extract text content
      let assistantText = '';
      const toolCalls: ToolCallContent[] = [];
      let thinkingText = '';

      if (typeof assistantMsg.content === 'string') {
        assistantText = assistantMsg.content;
      } else if (Array.isArray(assistantMsg.content)) {
        for (const block of assistantMsg.content as Array<Record<string, unknown>>) {
          if (block.type === 'text' || block.type === 'output_text') {
            const text = (block.text as string) || '';
            assistantText += text;
            // Simulate streaming
            onStream({ type: 'text_delta', text });
          } else if (block.type === 'thinking') {
            thinkingText += (block.text as string) || '';
            onStream({ type: 'thinking_delta', text: block.text as string });
          } else if (block.type === 'tool_use' || block.type === 'tool_call' || block.type === 'toolCall') {
            const args = block.arguments || block.input;
            const tc: ToolCallContent = {
              type: 'tool_call',
              id: (block.id as string) || `tc_${toolCalls.length}`,
              name: (block.name as string) || '',
              arguments:
                typeof args === 'string' ? args : JSON.stringify(args || {}),
            };
            toolCalls.push(tc);
          }
        }
      }

      if (!assistantText && toolCalls.length === 0 && !thinkingText) {
        throw new Error(
          `模型 ${settings.activeProvider}/${settings.activeModel} 返回了空响应，请检查 API Key、额度和模型权限。`,
        );
      }

      onStream({ type: 'text_end' });

      // No tool calls → done
      if (toolCalls.length === 0) {
        const contentBlocks: Array<{ type: string; text: string }> = [];
        if (thinkingText) {
          contentBlocks.push({ type: 'thinking', text: thinkingText });
        }
        contentBlocks.push({ type: 'text', text: assistantText || '已完成。' });

        return {
          finalMessage: {
            role: 'assistant',
            content: contentBlocks,
            toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
          },
          turnCount,
          tokenUsage,
        };
      }

      // Execute tool calls
      console.log(`[AgentLoop] Executing ${toolCalls.length} tool calls`);
      const toolResults: ToolResult[] = [];

      for (const tc of toolCalls) {
        if (abortSignal.aborted) {
          const err2 = new Error('已中止') as Error & { name: string };
          err2.name = 'AbortError';
          throw err2;
        }

        tc.status = 'running';
        completedToolCalls.push(tc);
        onToolStart({ ...tc });

        const tool = tools.find((t) => t.name === tc.name);
        if (!tool) {
          const err: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            success: false,
            error: `未知工具: ${tc.name}`,
            output: '',
          };
          tc.status = 'error';
          tc.result = err;
          toolResults.push(err);
          onToolEnd(err);
          console.warn(`[AgentLoop] Unknown tool: ${tc.name}`);
          continue;
        }

        let params: Record<string, unknown>;
        try {
          params = JSON.parse(tc.arguments);
        } catch {
          const err: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            success: false,
            error: `参数解析失败: ${tc.arguments}`,
            output: '',
          };
          tc.status = 'error';
          tc.result = err;
          toolResults.push(err);
          onToolEnd(err);
          continue;
        }

        try {
          console.log(`[AgentLoop] Executing tool: ${tc.name}`);
          const result = await tool.execute(params);
          result.toolCallId = tc.id;
          tc.status = result.success ? 'done' : 'error';
          tc.result = result;
          toolResults.push(result);
          onToolEnd(result);
          console.log(`[AgentLoop] Tool ${tc.name} result:`, result.success ? 'success' : 'error');
        } catch (error) {
          const err: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            success: false,
            error: (error as Error).message,
            output: '',
          };
          tc.status = 'error';
          tc.result = err;
          toolResults.push(err);
          onToolEnd(err);
        }
      }

      // Add assistant + tool results to context
      const assistantBlocks: Array<Record<string, unknown>> = [];
      if (assistantText) {
        assistantBlocks.push({ type: 'text', text: assistantText });
      }
      // Include tool calls as content blocks so pi-ai can process them on subsequent turns
      for (const tc of toolCalls) {
        assistantBlocks.push({
          type: 'toolCall',
          id: tc.id,
          name: tc.name,
          arguments: safeParseJson(tc.arguments),
        });
      }
      if (assistantBlocks.length === 0) {
        assistantBlocks.push({ type: 'text', text: assistantText || 'Done.' });
      }
      const assistantMsg2: Message = {
        role: 'assistant',
        content: assistantBlocks as Message['content'],
        toolCalls,
      };
      contextMessages.push(assistantMsg2);

      for (const tr of toolResults) {
        contextMessages.push({
          role: 'tool',
          content: tr.success ? tr.output : `错误: ${tr.error}`,
          toolCallId: tr.toolCallId,
        });
      }

      // Continue loop
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        throw new DOMException('Aborted', 'AbortError');
      }
      console.error('[AgentLoop] Error:', error);
      throw error;
    }
  }

  // Max turns reached
  return {
    finalMessage: {
      role: 'assistant',
      content: `已达到最大轮次限制（${settings.maxTurns}轮）。请尝试更具体的提问，或调整设置中的最大轮次。`,
      toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
    },
    turnCount,
    tokenUsage,
  };
}

// ===== Helpers =====

function getIdentityReply(messages: Message[]): string | null {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  if (!lastUserMessage) return null;

  const text =
    typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : lastUserMessage.content
          .filter((block) => block.type === 'text')
          .map((block) => ('text' in block ? block.text : ''))
          .join(' ');

  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[？?！!。.，,]/g, '');
  const identityQuestions = [
    '你是谁',
    '你叫什么',
    '你叫什么名字',
    '你的名字',
    '你的身份',
    'who are you',
    'what are you',
    'what is your name',
  ];

  if (!identityQuestions.includes(normalized)) return null;

  return /[\u3400-\u9fff]/.test(text)
    ? '我是 SunCode，你的 AI 编程助手。我可以帮助你阅读、编写、调试和重构代码，也能分析项目并执行开发命令。'
    : 'I am SunCode, your AI programming assistant. I can help you read, write, debug, and refactor code, analyze projects, and run development commands.';
}

function convertMessage(msg: Message): Record<string, unknown> {
  const role = msg.role === 'tool' ? 'user' : msg.role;

  if (typeof msg.content === 'string') {
    return { role, content: msg.content };
  }

  const content = msg.content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'thinking') return { type: 'thinking', text: block.text };
    if (block.type === 'tool_call')
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: safeParseJson(block.arguments),
      };
    // pi-ai uses 'toolCall' natively — pass through as-is
    if (block.type === 'toolCall') return block;
    return block;
  });

  return {
    role,
    content,
    ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
  };
}

function convertToolDef(tool: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: tool.parameters.properties || {},
      required: tool.parameters.required || [],
    },
  };
}

function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
