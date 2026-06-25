import { isIncompleteProgressText } from '@shared/finalization';
import type {
  Message,
  StreamEvent,
  SubagentProgressDelta,
  SubagentResult,
  ToolCallContent,
  ToolResult,
} from '@shared/types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { bridge } from '../api/bridge';
import { buildPersistedAssistantMessage } from './chat-message-persistence';

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
}

let msgCounter = 0;
function nextId(): string {
  return `msg_${Date.now()}_${++msgCounter}`;
}

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessage[]>([]);
  const isStreaming = ref(false);
  let currentAssistantMsg: ChatMessage | null = null;
  let currentText = '';
  let currentThinking = '';

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
    currentText = '';
    currentThinking = '';
    messages.value.push(assistantMessage);
    // Vue wraps objects inserted into a reactive array. Keep the wrapped
    // instance so stream mutations update the rendered message.
    currentAssistantMsg = messages.value[messages.value.length - 1];
    isStreaming.value = true;
  }

  function handleStreamEvent(event: StreamEvent): void {
    const msg = currentAssistantMsg;
    if (!msg) return;

    switch (event.type) {
      case 'turn_start':
        msg.turnCount = event.turnCount ?? 0;
        msg.maxTurns = event.maxTurns ?? 0;
        break;
      case 'turn_end':
        // Intermediate tool turns belong to the current assistant response.
        // Persist only after the final worker done event arrives.
        break;
      case 'text_delta':
        currentText += event.text || '';
        msg.content = currentText;
        break;
      case 'thinking_delta':
        currentThinking += event.text || '';
        msg.thinking = currentThinking;
        break;
      case 'text_end':
        msg.isStreaming = false;
        isStreaming.value = false;
        break;
      case 'toolcall_start':
        if (!msg.toolCalls) msg.toolCalls = [];
        msg.toolCalls.push({
          type: 'tool_call',
          id: event.toolCallId || '',
          name: event.toolName || '',
          arguments: '',
          // Record where in the thinking stream this tool appeared
          thinkingOffset: currentThinking.length,
        });
        break;
      case 'toolcall_delta': {
        const tc = msg.toolCalls?.find((t) => t.id === event.toolCallId);
        if (tc) {
          tc.arguments += event.delta || '';
        }
        break;
      }
      case 'toolcall_end':
        // Tool call completed
        break;
      case 'done':
        if (event.message) {
          const finalContent = event.message.content;
          if (typeof finalContent === 'string') {
            if (!msg.content) msg.content = finalContent;
          } else {
            // Extract text and thinking blocks from the final message.
            // The agent loop may have merged thinking into text when the model
            // produced reasoning-heavy but text-light output (common with
            // DeepSeek-like reasoning models).
            const finalText = finalContent
              .filter((block) => block.type === 'text')
              .map((block) => ('text' in block ? block.text : ''))
              .join('');
            const finalThinking = finalContent
              .filter((block) => block.type === 'thinking')
              .map((block) => ('text' in block ? block.text : ''))
              .join('');

            // Use final text if we didn't receive any streaming text deltas
            if (finalText && (!msg.content || isIncompleteProgressText(msg.content))) {
              msg.content = finalText;
            } else if (!msg.content && finalThinking) {
              // No text at all — use thinking as the visible answer
              msg.content = finalThinking;
            } else {
              // Content was already streamed (text_delta). But if the
              // streamed content is trivially short and the final message
              // has merged thinking into text, prefer the merged version.
              if (
                finalText &&
                msg.content &&
                msg.content.length < 60 &&
                finalText.length > msg.content.length
              ) {
                msg.content = finalText;
              }
            }

            // Update thinking if the final message has thinking blocks we
            // didn't receive during streaming (e.g. from task_complete path)
            if (finalThinking && !msg.thinking) {
              msg.thinking = finalThinking;
            }
          }
        }
        msg.isStreaming = false;
        isStreaming.value = false;
        void bridge.saveMessage(
          buildPersistedAssistantMessage({
            visibleContent: msg.content,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            finalMessage: event.message,
          }),
        );
        currentAssistantMsg = null;
        currentText = '';
        currentThinking = '';
        break;
      case 'error':
        msg.content += `\n\n❌ Error: ${event.error || 'Unknown error'}`;
        msg.isStreaming = false;
        isStreaming.value = false;
        currentAssistantMsg = null;
        currentText = '';
        currentThinking = '';
        break;
    }
  }

  /** Wire up tool execution start from worker — sets the tool call to running. */
  function startToolExecution(toolCall: ToolCallContent): void {
    const msg = currentAssistantMsg;
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
  function endToolExecution(result: ToolResult): void {
    const msg = currentAssistantMsg;
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
  function handleSubagentProgress(
    _executionId: string,
    _agent: string,
    delta: SubagentProgressDelta,
  ): void {
    const msg = currentAssistantMsg;
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
    currentText = '';
    currentThinking = '';
    isStreaming.value = false;
  }

  function clearMessages(): void {
    messages.value = [];
    currentAssistantMsg = null;
    currentText = '';
    currentThinking = '';
    isStreaming.value = false;
  }

  function loadMessages(sessionMessages: Message[]): void {
    clearMessages();
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

        return {
          id: nextId(),
          role: message.role as 'user' | 'assistant',
          content,
          thinking: thinking || undefined,
          toolCalls: message.toolCalls,
          timestamp: Date.now(),
          isStreaming: false,
        };
      });
  }

  return {
    messages,
    isStreaming,
    addUserMessage,
    startAssistantMessage,
    handleStreamEvent,
    startToolExecution,
    endToolExecution,
    handleSubagentProgress,
    finishCurrentResponse,
    clearMessages,
    loadMessages,
  };
});
