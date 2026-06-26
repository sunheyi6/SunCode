import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { MAX_TURNS } from '@shared/constants';
import type {
  AppSettings,
  ContentBlock,
  Message,
  RunEvent,
  StopHookRegistry,
  StreamEvent,
  ToolCallContent,
  ToolDefinition,
  ToolResult,
  TurnDecision,
} from '@shared/types';
import { TASK_COMPLETE_TOOL_NAME } from '../tools/task-complete';
import type { Tool } from '../tools/types';
import { buildSystemPrompt } from './system-prompt';
import {
  computeNeedsFollowUp,
  hasTaskCompleteToolCall,
  findTaskCompleteCall,
  taxonomyFromError,
  type NeedsFollowUpInput,
} from './turn-decision';

/** Context passed to prepareNextTurn so implementors can trim or adjust. */
export interface PrepareNextTurnContext {
  assistantText: string;
  thinkingText: string;
  toolResults: ToolResult[];
  contextMessages: Message[];
  turnCount: number;
  maxTurns: number;
  /** Model's maximum context window size (tokens). Available for budget decisions. */
  modelContextWindow?: number;
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
  /** Stable session identifier for prompt cache affinity. */
  sessionId: string;
  onStream: (event: StreamEvent) => void;
  onToolStart: (toolCall: ToolCallContent) => void;
  onToolEnd: (result: ToolResult) => void;
  /** Callback for recording run lifecycle events (turns, tools, etc.). */
  onRunEvent: (event: RunEvent) => void;
  initialTurnCount: number;
  /** Optional hook called after each intermediate turn. Can trim context or return
   *  new settings for the next turn (e.g. switch model, adjust thinking). */
  prepareNextTurn?: (ctx: PrepareNextTurnContext) => PrepareNextTurnResult | undefined;
  /** Stop hook registry for post-turn checks (verification, safety, etc.). */
  stopHooks?: StopHookRegistry;
  /** Whether there is pending user input that was queued while the agent was running. */
  hasPendingInput?: boolean;
  /** Callback to request user confirmation before executing a destructive tool.
   *  Only called when permissionMode is 'confirm_changes'. */
  requestConfirmation?: (toolCall: ToolCallContent) => Promise<boolean>;
}

export interface PrepareNextTurnResult {
  /** Replacement messages for the next turn (e.g. after compaction). */
  contextMessages?: Message[];
}

export interface AgentLoopResult {
  finalMessage: Message;
  turnCount: number;
  tokenUsage: { input: number; output: number; total: number };
  /** Structured decision about why the loop terminated. */
  decision: TurnDecision;
}

/**
 * Core agent loop: prompt → LLM stream → tool execution → repeat.
 *
 * Termination decisions are driven by `computeNeedsFollowUp()` (Codex-inspired):
 * - Model called tools → execute them, then continue
 * - Model called task_complete → explicit stop signal
 * - Model produced only text → natural stop (no follow-up needed)
 * - Budget / abort → stop
 *
 * Stop hooks run before finalizing any stop decision, allowing verification,
 * safety checks, or other post-turn processing to block or override.
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
    sessionId,
    onStream,
    onToolStart,
    onToolEnd,
    onRunEvent,
    initialTurnCount,
    prepareNextTurn,
    stopHooks,
    hasPendingInput: inputHasPending,
    requestConfirmation,
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
      decision: { decision: 'stop', reason: 'no_follow_up', taxonomy: 'completed' },
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

  // Emit system prompt for call trace panel
  onStream({ type: 'system_prompt', systemPrompt });

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

      console.log(
        `[AgentLoop] Calling streamSimple with ${piContext.messages.length} messages, cache=long, session=${sessionId.slice(0, 8)}`,
      );

      // Call the LLM with real token-by-token streaming + prompt caching
      const stream = streamSimpleFn(model, piContext, {
        reasoning: settings.thinkingLevel,
        signal: abortSignal,
        // Prompt caching — cacheRetention "long" requests Anthropic's 1h TTL
        cacheRetention: 'long',
        // Session affinity — same sessionId → same cache replica → higher hit rate
        sessionId,
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
            // Accumulate token usage from pi-ai (tallied per-turn)
            if (event.message.usage) {
              tokenUsage.input += event.message.usage.input || 0;
              tokenUsage.output += event.message.usage.output || 0;
              tokenUsage.total += event.message.usage.totalTokens || 0;
            }
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

      // ===== Turn Decision: compute whether we need another turn =====
      // Codex-style: model naturally expresses "done" by not calling tools,
      // or explicitly via task_complete. Stop hooks can override.
      const hasTaskComplete = hasTaskCompleteToolCall(toolCalls);
      const { decision: turnDecision } = computeNeedsFollowUp({
        toolCalls: toolCalls.filter((tc) => tc.name !== TASK_COMPLETE_TOOL_NAME),
        hasPendingInput: Boolean(inputHasPending),
        isMaxTurnsReached: turnCount >= (settings.maxTurns || MAX_TURNS),
        isAborted: false,
        assistantText,
        hasTaskComplete,
      });

      // task_complete → explicit signal, extract summary and return.
      if (hasTaskComplete) {
        const taskCompleteTC = findTaskCompleteCall(toolCalls);
        let summary = '';
        if (taskCompleteTC) {
          try {
            const args = JSON.parse(taskCompleteTC.arguments);
            summary = (args.summary as string) || '';
          } catch {
            // ignore parse failures
          }
        }
        if (summary) {
          assistantText = assistantText ? `${assistantText}\n\n${summary}` : summary;
        }

        const mergedText = mergeThinkingIntoAnswer(assistantText, thinkingText);

        onStream({ type: 'text_end' });
        onStream({ type: 'turn_end', turnCount, hasToolCalls: true });
        onRunEvent({
          type: 'turn_completed',
          runId,
          turnNumber: turnCount,
          hasToolCalls: true,
          timestamp: '',
          taxonomy: 'completed',
        });

        const contentBlocks: Array<
          { type: 'thinking'; text: string } | { type: 'text'; text: string }
        > = [];
        if (thinkingText) {
          contentBlocks.push({ type: 'thinking', text: thinkingText });
        }
        contentBlocks.push({ type: 'text', text: mergedText });

        return {
          finalMessage: { role: 'assistant', content: contentBlocks },
          turnCount,
          tokenUsage,
          decision: { decision: 'stop', reason: 'task_complete', taxonomy: 'completed' },
        };
      }

      // Non-task_complete tool calls → execute them and continue
      if (turnDecision.decision === 'continue' && toolCalls.length > 0) {
        // Fall through to tool execution below
      } else if (turnDecision.decision === 'stop') {
        // Stop decision: run stop hooks before finalizing
        if (stopHooks) {
          const hookResult = await stopHooks.runAll({
            assistantText,
            thinkingText,
            toolCalls,
            toolResults: [],
            turnCount,
            maxTurns: settings.maxTurns || MAX_TURNS,
            tokenUsage,
          });

          if (hookResult.shouldStop) {
            const mergedText = mergeThinkingIntoAnswer(assistantText, thinkingText);
            onStream({ type: 'text_end' });
            onStream({ type: 'turn_end', turnCount, hasToolCalls: false });
            onRunEvent({
              type: 'turn_completed',
              runId,
              turnNumber: turnCount,
              hasToolCalls: false,
              timestamp: '',
              taxonomy: 'blocked',
            });

            const contentBlocks: Array<
              { type: 'thinking'; text: string } | { type: 'text'; text: string }
            > = [];
            if (thinkingText) {
              contentBlocks.push({ type: 'thinking', text: thinkingText });
            }
            contentBlocks.push({ type: 'text', text: mergedText });

            return {
              finalMessage: { role: 'assistant', content: contentBlocks },
              turnCount,
              tokenUsage,
              decision: { decision: 'stop', reason: 'blocked', taxonomy: 'blocked' },
            };
          }

          if (hookResult.shouldBlock && hookResult.continuationPrompt) {
            contextMessages.push({
              role: 'assistant',
              content: [{ type: 'text', text: assistantText || '处理中...' }],
            });
            contextMessages.push({
              role: 'user',
              content: hookResult.continuationPrompt,
            });
            onStream({ type: 'turn_end', turnCount, hasToolCalls: false });
            onRunEvent({
              type: 'turn_completed',
              runId,
              turnNumber: turnCount,
              hasToolCalls: false,
              timestamp: '',
            });
            continue;
          }
        }

        // Normal stop — no follow-up needed, model is done
        const mergedText = mergeThinkingIntoAnswer(assistantText, thinkingText);

        onStream({ type: 'text_end' });
        onStream({ type: 'turn_end', turnCount, hasToolCalls: toolCalls.length > 0 });
        onRunEvent({
          type: 'turn_completed',
          runId,
          turnNumber: turnCount,
          hasToolCalls: toolCalls.length > 0,
          timestamp: '',
          taxonomy: turnDecision.taxonomy,
        });

        const contentBlocks: Array<
          { type: 'thinking'; text: string } | { type: 'text'; text: string }
        > = [];
        if (thinkingText) {
          contentBlocks.push({ type: 'thinking', text: thinkingText });
        }
        contentBlocks.push({ type: 'text', text: mergedText });

        return {
          finalMessage: { role: 'assistant', content: contentBlocks },
          turnCount,
          tokenUsage,
          decision: turnDecision,
        };
      }

      // Execute tool calls (parallel when multiple independent calls)
      console.log(`[AgentLoop] Executing ${toolCalls.length} tool calls`);

      if (abortSignal.aborted) {
        const err2 = new Error('已中止') as Error & { name: string };
        err2.name = 'AbortError';
        throw err2;
      }

      // Phase 1: Validate all tools synchronously, emit start events
      interface ValidatedCall {
        tc: (typeof toolCalls)[number];
        tool: Tool;
        params: Record<string, unknown>;
      }
      const toolResults: ToolResult[] = [];
      const toExecute: ValidatedCall[] = [];

      for (const tc of toolCalls) {
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
            error: `参数解析失败: ${tc.arguments}`,
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
          });
          continue;
        }

        // Validate required parameters
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
            const e: ToolResult = {
              toolCallId: tc.id,
              name: tc.name,
              success: false,
              error: `缺少必需参数: ${missing}`,
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
            });
            continue;
          }
        }

        // -- Permission: confirm destructive tools --
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
            });
            continue;
          }
        }

        toExecute.push({ tc, tool, params });
      }

      // Phase 2: Execute all valid tools in parallel
      if (toExecute.length > 0) {
        const mode = toExecute.length > 1 ? 'parallel' : 'single';
        console.log(`[AgentLoop] Executing ${toExecute.length} tools in ${mode}`);

        const settled = await Promise.allSettled(
          toExecute.map(async ({ tc, tool, params }) => {
            try {
              console.log(`[AgentLoop] Tool ${tc.name} executing...`);
              const result = await tool.execute(params);
              result.toolCallId = tc.id;
              onToolEnd(result);
              onRunEvent({
                type: 'tool_completed',
                runId,
                toolCallId: tc.id,
                toolName: tc.name,
                success: result.success,
                timestamp: '',
              });
              console.log(
                `[AgentLoop] Tool ${tc.name}: ${result.success ? 'success' : `error: ${result.error || 'unknown'}`}`,
              );
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
              });
              return e;
            }
          }),
        );

        for (const s of settled) {
          if (s.status === 'fulfilled') {
            toolResults.push(s.value);
          } else {
            // Promise rejection from the mapper itself (unlikely, but handle it)
            toolResults.push({
              toolCallId: '',
              name: 'unknown',
              success: false,
              error: `内部错误: ${s.reason}`,
              output: '',
            });
          }
        }
      }

      // Add assistant + tool results to context.
      // With real streaming, the model already correctly separates thinking
      // from text content — store each with its proper type as received.
      const assistantBlocks: ContentBlock[] = [];
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
        content: assistantBlocks,
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
      onRunEvent({
        type: 'turn_completed',
        runId,
        turnNumber: turnCount,
        hasToolCalls: true,
        timestamp: '',
      });

      // Allow hook to trim context or adjust state before the next turn
      if (prepareNextTurn) {
        // Extract model context window for budget-aware compaction
        const modelContextWindow = extractContextWindow(model);
        const result2 = prepareNextTurn({
          assistantText,
          thinkingText,
          toolResults,
          contextMessages,
          turnCount,
          maxTurns: settings.maxTurns || MAX_TURNS,
          modelContextWindow,
        });
        if (result2?.contextMessages) {
          // Replace the mutable context array contents
          contextMessages.length = 0;
          contextMessages.push(...result2.contextMessages);
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
    decision: { decision: 'stop', reason: 'max_turns', taxonomy: 'max_turns_exhausted' },
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

function convertToolDef(tool: ToolDefinition): Record<string, unknown> {
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

/**
 * Merge thinking content into the visible answer when the model outputs
 * substantial reasoning but little or no visible text.
 *
 * Reasoning models (DeepSeek, o1, etc.) often put the entire analysis in
 * the thinking/reasoning stream and produce only a token sentence as text.
 * Without merging, the user sees "已完成。" while the real answer is hidden
 * inside a collapsed thinking section.
 *
 * Strategy:
 * - If text is substantial (≥120 chars), return it unchanged.
 * - If text is short/empty but thinking is substantial, extract a useful
 *   summary from the end of the thinking stream (reasoning models typically
 *   conclude their chain-of-thought with the final answer).
 * - If nothing is available, fall back to a meaningful default.
 */
function mergeThinkingIntoAnswer(assistantText: string, thinkingText: string): string {
  const textLen = assistantText.trim().length;

  // Already has a meaningful visible answer — use it as-is
  if (textLen >= 120) return assistantText;

  // No thinking to fall back to
  if (!thinkingText || thinkingText.trim().length === 0) {
    return assistantText || '已完成。';
  }

  // Text is empty or too short, but thinking is available.
  // Reasoning models typically conclude their thinking with a summary —
  // extract the tail portion as the visible answer.
  const cleanThinking = thinkingText.trim();
  const thinkingLen = cleanThinking.length;

  // If thinking is short enough to show entirely, just use it
  if (thinkingLen <= 2000) {
    return assistantText ? `${assistantText}\n\n---\n\n${cleanThinking}` : cleanThinking;
  }

  // For long thinking, extract the concluding portion (last ~1500 chars).
  // Reasoning models tend to restate findings at the end of their chain-of-thought.
  const tail = cleanThinking.slice(-1500);
  // Try to start at a natural boundary (paragraph break or sentence end)
  const boundary = findNaturalBoundary(tail);
  const excerpt = tail.slice(boundary).trim();

  if (assistantText) {
    return `${assistantText}\n\n---\n\n${excerpt}`;
  }

  // Prepend a brief note so the user understands what they're reading
  return `思考结论：\n\n${excerpt}`;
}

/**
 * Find a natural text boundary (paragraph break, double newline, or period+newline)
 * within the first 300 chars of the given text. Returns the offset to start from.
 */
function findNaturalBoundary(text: string): number {
  // Prefer paragraph breaks
  const paraIdx = text.indexOf('\n\n');
  if (paraIdx !== -1 && paraIdx < 300) return paraIdx + 2;

  // Try to find end of a sentence followed by newline
  const sentenceMatch = text.slice(0, 400).match(/[。！？.!?]\n/g);
  if (sentenceMatch) {
    const firstMatch = sentenceMatch[0];
    if (firstMatch) {
      const idx = text.indexOf(firstMatch);
      if (idx !== -1) return idx + firstMatch.length;
    }
  }

  // Try to break at any newline
  const nlIdx = text.indexOf('\n');
  if (nlIdx !== -1 && nlIdx < 300) return nlIdx + 1;

  // Fallback: no good boundary found, start from beginning of extracted text
  return 0;
}

/**
 * Extract the model's context window size (in tokens) from the pi-ai model object.
 * Falls back to a conservative default if unavailable.
 */
function extractContextWindow(model: unknown): number {
  const m = model as Record<string, unknown> | null | undefined;
  if (!m) return 128_000;
  // Try common property names across providers
  for (const key of ['contextWindow', 'context_window', 'maxInputTokens', 'max_input_tokens']) {
    const val = m[key];
    if (typeof val === 'number' && val > 0) return val;
  }
  return 128_000; // Conservative default
}
