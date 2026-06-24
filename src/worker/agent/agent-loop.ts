import { MAX_TURNS } from '@shared/constants';
import type {
  AppSettings,
  Message,
  RunEvent,
  StreamEvent,
  ToolCallContent,
  ToolResult,
} from '@shared/types';
import type { Tool } from '../tools/types';
import { buildSystemPrompt } from './system-prompt';
import { TASK_COMPLETE_TOOL_NAME } from '../tools/task-complete';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';

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
  /** Auto-generated memories from prior sessions. */
  memoryContent?: string;
  abortSignal: AbortSignal;
  /** Unique identifier for this run (used for event logging). */
  runId: string;
  onStream: (event: StreamEvent) => void;
  onToolStart: (toolCall: ToolCallContent) => void;
  onToolEnd: (result: ToolResult) => void;
  /** Callback for recording run lifecycle events (turns, tools, etc.). */
  onRunEvent: (event: RunEvent) => void;
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
    memoryContent,
    abortSignal,
    runId,
    onStream,
    onToolStart,
    onToolEnd,
    onRunEvent,
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
    permissionMode: settings.permissionMode,
    agentsMdContent,
    memoryContent,
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
    onRunEvent({ type: 'turn_started', runId, turnNumber: turnCount, timestamp: '' });

    try {
      // Import pi-ai dynamically
      let streamSimpleFn: (
        model: unknown,
        context: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => AsyncIterable<AssistantMessageEvent>;
      try {
        const pi = await import('@earendil-works/pi-ai');
        streamSimpleFn = pi.streamSimple as unknown as typeof streamSimpleFn;
        if (!streamSimpleFn) {
          throw new Error('streamSimple not found in pi-ai exports');
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

      console.log(`[AgentLoop] Calling streamSimple with ${piContext.messages.length} messages`);

      // Call the LLM with real token-by-token streaming
      const stream = streamSimpleFn(model, piContext, {
        reasoning: settings.thinkingLevel,
        signal: abortSignal,
      });

      // Accumulate content as it streams in
      let assistantText = '';
      const toolCalls: ToolCallContent[] = [];
      let thinkingText = '';
      let assistantMsgRaw: Record<string, unknown> | null = null;

      for await (const event of stream) {
        switch (event.type) {
          case 'start':
            onStream({ type: 'start' });
            break;
          case 'text_start':
            onStream({ type: 'text_start' });
            break;
          case 'text_delta':
            assistantText += event.delta;
            onStream({ type: 'text_delta', text: event.delta });
            break;
          case 'text_end':
            // Per-content-block end — don't forward (our text_end means final turn)
            break;
          case 'thinking_start':
            onStream({ type: 'thinking_start' });
            break;
          case 'thinking_delta':
            thinkingText += event.delta;
            onStream({ type: 'thinking_delta', text: event.delta });
            break;
          case 'thinking_end':
            onStream({ type: 'thinking_end' });
            break;
          case 'toolcall_start': {
            const partialBlock = event.partial.content[event.contentIndex] as unknown as
              | Record<string, unknown>
              | undefined;
            const tcId = (partialBlock?.id as string) || '';
            const tcName = (partialBlock?.name as string) || '';
            onStream({ type: 'toolcall_start', toolCallId: tcId, toolName: tcName });
            break;
          }
          case 'toolcall_delta': {
            const partialBlock = event.partial.content[event.contentIndex] as unknown as
              | Record<string, unknown>
              | undefined;
            const tcId = (partialBlock?.id as string) || '';
            onStream({ type: 'toolcall_delta', toolCallId: tcId, delta: event.delta });
            break;
          }
          case 'toolcall_end': {
            const tc: ToolCallContent = {
              type: 'tool_call',
              id: event.toolCall.id,
              name: event.toolCall.name,
              arguments: JSON.stringify(event.toolCall.arguments),
            };
            toolCalls.push(tc);
            onStream({ type: 'toolcall_end', toolCallId: tc.id, toolName: tc.name });
            break;
          }
          case 'done':
            assistantMsgRaw = event.message as unknown as Record<string, unknown>;
            break;
          case 'error': {
            if (event.reason === 'aborted') {
              const err = new Error('已中止') as Error & { name: string };
              err.name = 'AbortError';
              throw err;
            }
            const errMsg =
              ((event.error as unknown as Record<string, unknown>)?.errorMessage as string) ||
              'LLM stream error';
            throw new Error(errMsg);
          }
        }
      }

      console.log(`[AgentLoop] Stream done:`, {
        assistantTextLen: assistantText.length,
        thinkingTextLen: thinkingText.length,
        toolCalls: toolCalls.length,
        stopReason: assistantMsgRaw?.stopReason,
      });

      // Handle error stop reason from the final message
      if (assistantMsgRaw?.stopReason === 'error') {
        throw new Error(
          (assistantMsgRaw.errorMessage as string) ||
            `模型 ${settings.activeProvider}/${settings.activeModel} 请求失败，请检查 API Key 和网络连接。`,
        );
      }

      if (!assistantText && toolCalls.length === 0 && !thinkingText) {
        throw new Error(
          `模型 ${settings.activeProvider}/${settings.activeModel} 返回了空响应，请检查 API Key、额度和模型权限。`,
        );
      }

      // No tool calls → final turn. Send text_end so the frontend finalises.
      if (toolCalls.length === 0) {
        onStream({ type: 'text_end' });
        onStream({ type: 'turn_end', turnCount, hasToolCalls: false });
        onRunEvent({
          type: 'turn_completed',
          runId,
          turnNumber: turnCount,
          hasToolCalls: false,
          timestamp: '',
        });

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

      // task_complete tool → model explicitly signals that the task is done.
      // Treat this as a final turn: extract the summary, skip tool execution,
      // and return the final message immediately.
      const taskCompleteTC = toolCalls.find((tc) => tc.name === TASK_COMPLETE_TOOL_NAME);
      if (taskCompleteTC) {
        let summary = '';
        try {
          const args = JSON.parse(taskCompleteTC.arguments);
          summary = (args.summary as string) || '';
        } catch {
          // If arguments can't be parsed, just use whatever text the model output
        }

        if (summary) {
          assistantText = assistantText ? `${assistantText}\n\n${summary}` : summary;
        }

        onStream({ type: 'text_end' });
        onStream({ type: 'turn_end', turnCount, hasToolCalls: true });
        onRunEvent({
          type: 'turn_completed',
          runId,
          turnNumber: turnCount,
          hasToolCalls: true,
          timestamp: '',
        });

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
        onRunEvent({
          type: 'tool_started',
          runId,
          toolCallId: tc.id,
          toolName: tc.name,
          timestamp: '',
        });

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
          onRunEvent({
            type: 'tool_completed',
            runId,
            toolCallId: tc.id,
            toolName: tc.name,
            success: false,
            timestamp: '',
          });
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
          onRunEvent({
            type: 'tool_completed',
            runId,
            toolCallId: tc.id,
            toolName: tc.name,
            success: false,
            timestamp: '',
          });
          continue;
        }

        // Validate required parameters — skip the tool if any are missing.
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
            onRunEvent({
              type: 'tool_completed',
              runId,
              toolCallId: tc.id,
              toolName: tc.name,
              success: false,
              timestamp: '',
            });
            continue;
          }
        }

        try {
          console.log(`[AgentLoop] Executing tool: ${tc.name}`);
          const result = await tool.execute(params);
          result.toolCallId = tc.id;
          toolResults.push(result);
          onToolEnd(result);
          onRunEvent({
            type: 'tool_completed',
            runId,
            toolCallId: tc.id,
            toolName: tc.name,
            success: result.success,
            timestamp: '',
          });
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
          onRunEvent({
            type: 'tool_completed',
            runId,
            toolCallId: tc.id,
            toolName: tc.name,
            success: false,
            timestamp: '',
          });
        }
      }

      // Add assistant + tool results to context.
      // With real streaming, the model already correctly separates thinking
      // from text content — store each with its proper type as received.
      const assistantBlocks: Array<Record<string, unknown>> = [];
      if (thinkingText) {
        assistantBlocks.push({ type: 'thinking', text: thinkingText });
      }
      if (assistantText) {
        assistantBlocks.push({ type: 'text', text: assistantText });
      }
      // Always construct content as an array so downstream consumers
      // (e.g. pi-ai's transformMessages → .flatMap) don't break on a string.
      if (assistantBlocks.length === 0) {
        assistantBlocks.push({ type: 'text', text: assistantText || '处理中...' });
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
