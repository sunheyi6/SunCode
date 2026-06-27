import type {
  Message,
  RunEvent,
  StreamEvent,
  SubagentProgressDelta,
  SubagentResult,
  TaskPlan,
  ToolCallContent,
  ToolResult,
  TurnDetail,
} from '@shared/types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { bridge } from '../api/bridge';
import { buildPersistedAssistantMessage } from './chat-message-persistence';
import { parseTaskPlan, stripPlanFromContent } from '../utils/task-plan-parser';
import { useAgentStore } from './agent';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  toolCalls?: ToolCallContent[];
  timestamp: number;
  isStreaming: boolean;
  /** Current turn number (updated by turn_start events). */
  turnCount?: number;
  /** Max turns for this session. */
  maxTurns?: number;
  /** System prompt for the current run (for call trace panel). */
  systemPrompt?: string;
  /** Structured task plan parsed from the model's text output. */
  taskPlan?: TaskPlan;
  /** Per-turn LLM request/response details (for call trace panel). */
  turnDetails?: TurnDetail[];
}

let msgCounter = 0;
function nextId(): string {
  return `msg_${Date.now()}_${++msgCounter}`;
}

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessage[]>([]);
  const isStreaming = ref(false);
  const showCallTrace = ref(false);
  let currentAssistantMsg: ChatMessage | null = null;
  let lastParsedPlanLength = 0;

  /** ID of the renderer's currently visible session. */
  let activeSessionId: string | null = null;
  /** IDs of all sessions with an active agent run (supports concurrent runs). */
  const streamingSessionIds = new Set<string>();
  /** In-progress assistant messages for sessions the user left mid-stream. */
  const pendingAssistantMessages = new Map<string, ChatMessage>();

  function addUserMessage(text: string): void {
    messages.value.push({
      id: nextId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      isStreaming: false,
    });
  }

  function startAssistantMessage(): void {
    const assistantMessage: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      thinking: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
    lastParsedPlanLength = 0;
    messages.value.push(assistantMessage);
    // Vue wraps objects inserted into a reactive array. Keep the wrapped
    // instance so stream mutations update the rendered message.
    currentAssistantMsg = messages.value[messages.value.length - 1];
    isStreaming.value = true;
    if (activeSessionId) streamingSessionIds.add(activeSessionId);
  }

  /** Return the assistant message that should receive stream/tool events for a given session.
   *  Active session → currentAssistantMsg; inactive session → pending snapshot. */
  function activeAssistantMessage(sessionId: string): ChatMessage | null {
    if (sessionId === activeSessionId) return currentAssistantMsg;
    return pendingAssistantMessages.get(sessionId) ?? null;
  }

  /** Create a fresh assistant message in pending state for an inactive session. */
  function createPendingAssistant(sessionId: string): ChatMessage {
    const msg: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      thinking: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
    pendingAssistantMessages.set(sessionId, msg);
    return msg;
  }

  function handleStreamEvent(event: StreamEvent, sessionId: string): void {
    const msg = activeAssistantMessage(sessionId);

    switch (event.type) {
      case 'system_prompt':
        if (msg) msg.systemPrompt = event.systemPrompt || '';
        break;

      case 'turn_start':
        if (msg) {
          msg.turnCount = event.turnCount ?? 0;
          msg.maxTurns = event.maxTurns ?? 0;
        }
        break;

      case 'turn_end':
        // Intermediate tool turns belong to the current assistant response.
        break;

      case 'message_start':
        // Create streaming message context if not already present
        if (!msg) {
          if (sessionId === activeSessionId) {
            startAssistantMessage();
          } else {
            createPendingAssistant(sessionId);
          }
        }
        streamingSessionIds.add(sessionId);
        break;

      case 'message_update':
      case 'message_end': {
        if (!msg && event.type === 'message_update') {
          if (sessionId === activeSessionId) {
            startAssistantMessage();
          } else {
            createPendingAssistant(sessionId);
          }
          streamingSessionIds.add(sessionId);
        }
        const target = activeAssistantMessage(sessionId);
        if (!target) break;

        const data = event.data;
        if (!data) break;

        target.content = data.text || '';
        target.thinking = data.thinking || '';
        // Accumulate tool calls across turns — the model reports only the current
        // turn's calls in each message_update, so we merge by ID to avoid duplicates.
        const incoming = data.toolCalls || [];
        if (incoming.length > 0) {
          const existing = target.toolCalls ?? [];
          const existingIds = new Set(existing.map((t) => t.id));
          const merged = [...existing];
          for (const tc of incoming) {
            const idx = existing.findIndex((t) => t.id === tc.id);
            if (idx >= 0) {
              merged[idx] = tc; // update in place (status/result may have changed)
            } else if (!existingIds.has(tc.id)) {
              merged.push(tc);
            }
          }
          target.toolCalls = merged;
        }
        target.isStreaming = event.type === 'message_update';
        if (sessionId === activeSessionId) {
          isStreaming.value = event.type === 'message_update';
        }

        // Parse task plan on message_update (throttled)
        if (event.type === 'message_update' && data.text) {
          if (data.text.length - lastParsedPlanLength >= 30 || data.text.includes('[PLAN]')) {
            const plan = parseTaskPlan(data.text, true);
            if (plan) target.taskPlan = plan;
            lastParsedPlanLength = data.text.length;
          }
        }

        if (event.type === 'message_end') {
          target.isStreaming = false;
          streamingSessionIds.delete(sessionId);
          if (sessionId === activeSessionId) {
            isStreaming.value = false;
          }

          // Persist completed message to the session that originated the run
          void bridge.saveMessage(
            buildPersistedAssistantMessage({
              visibleContent: target.content,
              thinking: target.thinking,
              toolCalls: target.toolCalls,
              systemPrompt: target.systemPrompt,
              turnDetails: target.turnDetails,
              finalMessage: event.message,
            }),
            sessionId,
          );

          if (sessionId === activeSessionId) {
            currentAssistantMsg = null;
          }
          pendingAssistantMessages.delete(sessionId);
        }
        break;
      }

      case 'error':
        if (msg) {
          msg.content += `\n\n❌ Error: ${event.error || 'Unknown error'}`;
          msg.isStreaming = false;
        }
        streamingSessionIds.delete(sessionId);
        if (sessionId === activeSessionId) {
          isStreaming.value = false;
          currentAssistantMsg = null;
        }
        pendingAssistantMessages.delete(sessionId);
        break;
    }
  }

  /** Wire up tool execution start from worker — sets the tool call to running. */
  function startToolExecution(toolCall: ToolCallContent, sessionId: string): void {
    const msg = activeAssistantMessage(sessionId);
    if (!msg) return;
    if (!msg.toolCalls) msg.toolCalls = [];
    let target = msg.toolCalls.find((t) => t.id === toolCall.id);
    if (target) {
      target.status = 'running';
      target.arguments = target.arguments || toolCall.arguments;
    } else {
      target = { ...toolCall, status: 'running' };
      msg.toolCalls.push(target);
    }
    // For subagent tool: pre-populate result so SubagentCard shows agent names immediately
    // and handleSubagentProgress can stream updates to the right target.
    if (toolCall.name === 'subagent' && !target.result) {
      try {
        const args = JSON.parse(target.arguments || toolCall.arguments);
        // Batch mode: calls[] array
        const calls = args.calls as Array<{ agent: string; prompt: string }> | undefined;
        // Single-call mode: agent + prompt
        const singleAgent = args.agent as string | undefined;
        const singlePrompt = args.prompt as string | undefined;

        const agents: Array<{ agent: string; prompt: string }> =
          calls && calls.length > 0
            ? calls
            : singleAgent && singlePrompt
              ? [{ agent: singleAgent, prompt: singlePrompt }]
              : [];

        if (agents.length > 0) {
          (target as unknown as Record<string, unknown>).result = {
            success: true,
            output: '',
            subagentResults: agents.map((c) => ({
              agent: c.agent,
              success: true,
              output: '执行中...',
              toolCalls: 0,
              tokenUsage: { input: 0, output: 0, total: 0 },
            })),
          };
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }

  /** Wire up tool execution result from worker — attaches output/error to the tool call. */
  function endToolExecution(result: ToolResult, sessionId: string): void {
    const msg = activeAssistantMessage(sessionId);
    if (!msg?.toolCalls) return;
    const tc = msg.toolCalls.find((t) => t.id === result.toolCallId);
    if (tc) {
      tc.status = result.success ? 'done' : 'error';
      tc.result = result;
      if (result.name === 'subagent') {
        console.log(
          '[ChatStore] endToolExecution subagent: subagentResults=',
          result.subagentResults?.length,
          'thinking=',
          result.subagentResults?.[0]?.thinking?.length,
          'internalCalls=',
          result.subagentResults?.[0]?.internalCalls?.length,
        );
      }
    }
  }

  /** Handle incremental sub-agent progress: thinking deltas and tool calls. */
  /** Handle run lifecycle events — convert model_request_completed to TurnDetail
   *  and accumulate on the current assistant message for the call trace panel. */
  function handleRunEvent(event: RunEvent, sessionId: string): void {
    if (event.type !== 'model_request_completed') return;
    const msg = activeAssistantMessage(sessionId);
    if (!msg) return;
    if (!msg.turnDetails) msg.turnDetails = [];
    // Avoid duplicate entries (same turn number can emit twice in error retry)
    const existing = msg.turnDetails.find((t) => t.turnNumber === event.turnNumber);
    if (existing) {
      // Update in place (retry may have different data)
      Object.assign(existing, turnDetailFromRunEvent(event));
    } else {
      msg.turnDetails.push(turnDetailFromRunEvent(event));
    }
  }

  /** Convert a model_request_completed RunEvent to a TurnDetail UI object. */
  function turnDetailFromRunEvent(
    event: Extract<RunEvent, { type: 'model_request_completed' }>,
  ): TurnDetail {
    return {
      turnNumber: event.turnNumber,
      systemTokens: event.systemTokens ?? 0,
      requestMessages: event.requestMessages ?? [],
      response: {
        text: event.responseText ?? '',
        thinking: event.responseThinking ?? '',
        toolCalls: event.responseToolCalls ?? [],
        stopReason: event.stopReason,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        totalTokens: event.totalTokens,
        durationMs: event.durationMs,
      },
    };
  }

  function handleSubagentProgress(
    _executionId: string,
    _agent: string,
    delta: SubagentProgressDelta,
    sessionId: string,
  ): void {
    const msg = activeAssistantMessage(sessionId);
    if (!msg?.toolCalls) return;
    // Find the subagent tool call (there should be only one running at a time)
    const subTc = msg.toolCalls.find((t) => t.name === 'subagent' && t.status === 'running');
    if (!subTc) return;

    // Ensure result container exists
    const tcResult = (subTc as unknown as Record<string, unknown>).result as ToolResult | undefined;
    if (!tcResult?.subagentResults) return;

    const results = tcResult.subagentResults;
    const target = results.find((r: SubagentResult) => r.agent === _agent);
    if (!target) return;

    switch (delta.type) {
      case 'thinking': {
        target.thinking = (target.thinking || '') + (delta.text || '');
        break;
      }
      case 'tool_start': {
        if (!delta.toolCall) return;
        if (!target.internalCalls) target.internalCalls = [];
        target.internalCalls.push(delta.toolCall);
        break;
      }
      case 'tool_end': {
        const existing = target.internalCalls?.find((tc) => tc.id === delta.toolResult?.toolCallId);
        if (existing && delta.toolResult) {
          existing.status = delta.toolResult.success ? 'done' : 'error';
          existing.result = delta.toolResult;
        }
        break;
      }
    }
  }

  function finishCurrentResponse(): void {
    if (currentAssistantMsg) {
      currentAssistantMsg.isStreaming = false;
    }
    currentAssistantMsg = null;
    // Clear streaming state for the active session
    if (activeSessionId) {
      streamingSessionIds.delete(activeSessionId);
    }
    isStreaming.value = false;
  }

  function setActiveSessionId(id: string | null): void {
    activeSessionId = id;
  }

  function snapshotStreamingAssistant(): void {
    if (!activeSessionId || !currentAssistantMsg) return;
    pendingAssistantMessages.set(activeSessionId, currentAssistantMsg);
  }

  function clearMessages(): void {
    messages.value = [];
    currentAssistantMsg = null;
    isStreaming.value = false;
  }

  function loadMessages(sessionId: string, sessionMessages: Message[]): void {
    // If we are leaving a session with a streaming assistant message,
    // keep the partial message so it can be restored when the user comes back.
    console.log(
      `[ChatStore] loadMessages id=${sessionId.slice(-8)} count=${sessionMessages?.length ?? 0} roles=${sessionMessages?.map((m) => m.role).join(',') || '(none)'}`,
    );
    snapshotStreamingAssistant();
    clearMessages();

    activeSessionId = sessionId;
    messages.value = sessionMessages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => {
        const blocks = typeof message.content === 'string' ? [] : message.content;
        const content =
          typeof message.content === 'string'
            ? message.content
            : blocks
                .filter((block) => block.type === 'text')
                .map((block) => ('text' in block ? block.text : ''))
                .join('');
        const thinking = blocks
          .filter((block) => block.type === 'thinking')
          .map((block) => ('text' in block ? block.text : ''))
          .join('');

        const taskPlan = parseTaskPlan(content, false) ?? undefined;
        const displayContent = taskPlan ? stripPlanFromContent(content) : content;

        return {
          id: nextId(),
          role: message.role as 'user' | 'assistant',
          content: displayContent,
          thinking: thinking || undefined,
          toolCalls: message.toolCalls,
          timestamp: Date.now(),
          isStreaming: false,
          systemPrompt: message.systemPrompt,
          turnDetails: message.turnDetails,
          taskPlan,
        };
      });

    // Restoring an in-progress assistant message for this session lets the user
    // see ongoing streaming / tool calls (or the completed answer waiting for
    // the final done event) immediately after switching back.
    const pending = pendingAssistantMessages.get(sessionId);
    if (pending) {
      messages.value.push(pending);
      currentAssistantMsg = pending;
      isStreaming.value = pending.isStreaming;
      // Sync global agent status from per-session tracker
      const agentStatus = useAgentStore().getSessionStatus(sessionId);
      if (agentStatus.state !== 'idle' || agentStatus.tokenUsage.total > 0) {
        useAgentStore().setStatus(agentStatus);
      }
    } else if (streamingSessionIds.has(sessionId)) {
      // Session has a running agent but no pending message yet — sync status
      const agentStatus = useAgentStore().getSessionStatus(sessionId);
      useAgentStore().setStatus(agentStatus);
    }
  }

  function toggleCallTrace(): void {
    showCallTrace.value = !showCallTrace.value;
  }

  // ── Model switch notice ─────────────────────────────────────────────
  const modelSwitchNotice = ref<string | null>(null);

  function setModelSwitchNotice(text: string): void {
    modelSwitchNotice.value = text;
  }

  function dismissModelSwitchNotice(): void {
    modelSwitchNotice.value = null;
  }

  return {
    messages,
    isStreaming,
    showCallTrace,
    toggleCallTrace,
    setActiveSessionId,
    addUserMessage,
    startAssistantMessage,
    handleStreamEvent,
    handleRunEvent,
    startToolExecution,
    endToolExecution,
    handleSubagentProgress,
    finishCurrentResponse,
    clearMessages,
    loadMessages,
    /** Set of session IDs with an active agent run (for sidebar breathing indicator). */
    streamingSessionIds,
    modelSwitchNotice,
    setModelSwitchNotice,
    dismissModelSwitchNotice,
  };
});
