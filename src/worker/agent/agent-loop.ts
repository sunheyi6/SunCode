import { MAX_TURNS } from '@shared/constants';
import type { AppSettings, Message, StreamEvent, ToolCallContent, ToolResult } from '@shared/types';
import type { Tool } from '../tools/types';
import { buildSystemPrompt } from './system-prompt';

/** Context passed to prepareNextTurn so implementors can trim or adjust. */
export interface PrepareNextTurnContext {
  assistantText: string;
  thinkingText: string;
  toolResults: ToolResult[];
  contextMessages: Message[];
  turnCount: number;
  maxTurns: number;
}

export interface AgentLoopInput {
  model: unknown; // pi-ai Model type
  messages: Message[];
  tools: Tool[];
  settings: AppSettings;
  workingDir: string;
  skillsContent: string;
  /** Content from .agents.md / AGENTS.md (Codex-style workspace instructions). */
  agentsMdContent?: string;
  abortSignal: AbortSignal;
  onStream: (event: StreamEvent) => void;
  onToolStart: (toolCall: ToolCallContent) => void;
  onToolEnd: (result: ToolResult) => void;
  initialTurnCount: number;
  /** Optional hook called after each intermediate turn. Can trim context or return
   *  new settings for the next turn (e.g. switch model, adjust thinking). */
  prepareNextTurn?: (ctx: PrepareNextTurnContext) => PrepareNextTurnResult | undefined;
}

export interface PrepareNextTurnResult {
  /** Replacement messages for the next turn (e.g. after compaction). */
  contextMessages?: Message[];
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
  options?: Record<string, unknown>,
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
    prepareNextTurn,
  } = input;

  if (!model) {
    throw new Error('未配置模型。请在设置中选择一个模型并配置 API Key。');
  }

  const contextMessages: Message[] = [...initialMessages];
  let turnCount = initialTurnCount;
  const tokenUsage = { input: 0, output: 0, total: 0 };

  const identityReply = getIdentityReply(initialMessages);
  if (identityReply) {
    onStream({ type: 'text_delta', text: identityReply });
    onStream({ type: 'text_end' });
    return {
      finalMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: identityReply }],
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
    onStream({ type: 'turn_start', turnCount, maxTurns: settings.maxTurns || MAX_TURNS });

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
        systemPrompt,
        messages: contextMessages.filter((m) => m.role !== 'system').map(convertMessage),
        tools: toolDefs.map(convertToolDef),
      };

      console.log(`[AgentLoop] Calling completeSimple with ${piContext.messages.length} messages`);

      // Call the LLM
      const assistantMsg = await completeSimple(model, piContext, {
        reasoning: settings.thinkingLevel,
        signal: abortSignal,
      });

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

      // If the model stopped because it wants to use tools, any text it
      // produced in this turn is intermediate narration — treat it as
      // thinking so the final UI shows it inside the collapsible section.
      const isToolUseTurn =
        assistantMsg.stopReason === 'toolUse' ||
        assistantMsg.stopReason === 'tool_use' ||
        assistantMsg.stopReason === 'toolCall' ||
        assistantMsg.stopReason === 'tool_call';

      if (typeof assistantMsg.content === 'string') {
        assistantText = assistantMsg.content;
        // Stream as thinking when this turn is just an intermediate step
        if (isToolUseTurn) {
          if (!thinkingText) onStream({ type: 'thinking_start' });
          thinkingText += assistantText;
          onStream({ type: 'thinking_delta', text: assistantText });
        } else {
          onStream({ type: 'text_delta', text: assistantText });
        }
      } else if (Array.isArray(assistantMsg.content)) {
        for (const block of assistantMsg.content as Array<Record<string, unknown>>) {
          if (block.type === 'text' || block.type === 'output_text') {
            const text = (block.text as string) || '';
            assistantText += text;
            // Simulate streaming — intermediate narration → thinking
            if (isToolUseTurn) {
              if (!thinkingText) onStream({ type: 'thinking_start' });
              thinkingText += text;
              onStream({ type: 'thinking_delta', text });
            } else {
              onStream({ type: 'text_delta', text });
            }
          } else if (block.type === 'thinking') {
            const thinking = (block.thinking as string) || (block.text as string) || '';
            if (thinking) {
              if (!thinkingText) onStream({ type: 'thinking_start' });
              thinkingText += thinking;
              onStream({ type: 'thinking_delta', text: thinking });
            }
          } else if (
            block.type === 'toolUse' ||
            block.type === 'toolCall' ||
            block.type === 'tool_use' ||
            block.type === 'tool_call'
          ) {
            const tc: ToolCallContent = {
              type: 'tool_call',
              id: (block.id as string) || `tc_${toolCalls.length}`,
              name: (block.name as string) || '',
              arguments:
                typeof block.arguments === 'string'
                  ? block.arguments
                  : JSON.stringify(block.arguments || block.input || {}),
            };
            toolCalls.push(tc);
          }
        }
      }

      if (thinkingText) onStream({ type: 'thinking_end' });

      if (!assistantText && toolCalls.length === 0 && !thinkingText) {
        throw new Error(
          `模型 ${settings.activeProvider}/${settings.activeModel} 返回了空响应，请检查 API Key、额度和模型权限。`,
        );
      }

      // No tool calls → final turn. Send text_end so the frontend finalises.
      if (toolCalls.length === 0) {
        onStream({ type: 'text_end' });
        onStream({ type: 'turn_end', turnCount, hasToolCalls: false });

        const contentBlocks: Array<{ type: string; text: string }> = [];
        if (thinkingText) {
          contentBlocks.push({ type: 'thinking', text: thinkingText });
        }
        contentBlocks.push({ type: 'text', text: assistantText || '已完成。' });

        return {
          finalMessage: {
            role: 'assistant',
            content: contentBlocks,
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

        onToolStart(tc);

        const tool = tools.find((t) => t.name === tc.name);
        if (!tool) {
          const err: ToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            success: false,
            error: `未知工具: ${tc.name}`,
            output: '',
          };
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
          toolResults.push(err);
          onToolEnd(err);
          continue;
        }

        // Validate required parameters — skip the tool if any are missing.
        {
          const def = tool.getDefinition();
          const required = (def.parameters as { required?: string[] }).required ?? [];
          const props = (def.parameters as { properties?: Record<string, { type: string }> }).properties ?? {};
          let missing: string | null = null;
          for (const key of required) {
            if (params[key] === undefined || params[key] === null) {
              missing = key;
              break;
            }
            // Coerce numbers passed as strings (common LLM mistake)
            if (props[key]?.type === 'integer' && typeof params[key] === 'string') {
              const n = Number(params[key]);
              if (Number.isFinite(n)) params[key] = n;
            }
          }
          if (missing) {
            const err2: ToolResult = {
              toolCallId: tc.id,
              name: tc.name,
              success: false,
              error: `缺少必需参数: ${missing}`,
              output: '',
            };
            toolResults.push(err2);
            onToolEnd(err2);
            continue;
          }
        }

        try {
          console.log(`[AgentLoop] Executing tool: ${tc.name}`);
          const result = await tool.execute(params);
          result.toolCallId = tc.id;
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
          toolResults.push(err);
          onToolEnd(err);
        }
      }

      // Add assistant + tool results to context.
      // Intermediate narration text (when tools follow) should be stored as
      // thinking blocks so it ends up in the collapsible section, not the
      // final answer body.
      const assistantBlocks: Array<Record<string, unknown>> = [];
      const textBlockType = isToolUseTurn ? 'thinking' : 'text';
      if (assistantText) {
        assistantBlocks.push({ type: textBlockType, text: assistantText });
      }
      // Always construct content as an array so downstream consumers
      // (e.g. pi-ai's transformMessages → .flatMap) don't break on a string.
      if (assistantBlocks.length === 0) {
        assistantBlocks.push({ type: textBlockType, text: assistantText || '处理中...' });
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

      // Emit turn_end for intermediate (tool-use) turns
      onStream({ type: 'turn_end', turnCount, hasToolCalls: true });

      // Allow hook to trim context or adjust state before the next turn
      if (prepareNextTurn) {
        const result = prepareNextTurn({
          assistantText,
          thinkingText,
          toolResults,
          contextMessages,
          turnCount,
          maxTurns: settings.maxTurns || MAX_TURNS,
        });
        if (result?.contextMessages) {
          // Replace the mutable context array contents
          contextMessages.length = 0;
          contextMessages.push(...result.contextMessages);
        }
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
