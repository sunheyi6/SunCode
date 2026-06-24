import type { Message, StreamEvent, SubagentProgressDelta, SubagentResult, ToolCallContent, ToolResult } from '@shared/types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { bridge } from '../api/bridge';

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
        // Intermediate turn with tool calls — save accumulated state to session
        if (event.hasToolCalls && msg.toolCalls && msg.toolCalls.length > 0) {
          console.log('[ChatStore] turn_end save: toolCalls=', msg.toolCalls.length, 'thinking=', (msg.thinking?.length ?? 0), 'content=', (msg.content?.length ?? 0));
          const content: Message['content'] = [];
          if (msg.thinking) content.push({ type: 'thinking', text: msg.thinking });
          if (msg.content) content.push({ type: 'text', text: msg.content });
          void bridge.saveMessage({
            role: 'assistant',
            content: content.length > 0 ? content : '思考中...',
            toolCalls: msg.toolCalls.map((tc) => ({
              type: 'tool_call' as const,
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
              status: tc.status,
              result: tc.result,
            })),
          }).then(() => {
            console.log('[ChatStore] turn_end save: OK');
          }).catch((e: Error) => {
            console.error('[ChatStore] turn_end save FAILED:', e.message);
          });
        }
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
        // Save message
        {
          const content: Message['content'] = [];
          if (msg.thinking) content.push({ type: 'thinking', text: msg.thinking });
          content.push({ type: 'text', text: msg.content });
          void bridge.saveMessage({
            role: 'assistant',
            content,
          });
        }
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
            // Extract all text blocks for the final answer body.
            // If the model only returned thinking blocks, fall back to
            // those so the final answer always shows outside the thinking
            // section.
            const textBlocks = finalContent
              .filter((block) => block.type === 'text')
              .map((block) => ('text' in block ? block.text : ''))
              .join('');
            if (textBlocks) {
              // Only set from done if we haven't already received text via streaming (text_delta).
              // Otherwise streaming + done = duplicate.
              if (!msg.content) {
                msg.content = textBlocks;
              }
            } else if (!msg.content) {
              // No text blocks — use thinking blocks as the visible answer
              msg.content = finalContent
                .filter((block) => block.type === 'thinking')
                .map((block) => ('text' in block ? block.text : ''))
                .join('');
              if (!msg.content) msg.content = '已完成。';
            }
          }
        }
        msg.isStreaming = false;
        isStreaming.value = false;
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
      } catch { /* ignore parse errors */ }
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
        console.log('[ChatStore] endToolExecution subagent: subagentResults=', result.subagentResults?.length, 'thinking=', result.subagentResults?.[0]?.thinking?.length, 'internalCalls=', result.subagentResults?.[0]?.internalCalls?.length);
      }
    }
  }

  /** Handle incremental sub-agent progress: thinking deltas and tool calls. */
  function handleSubagentProgress(_executionId: string, _agent: string, delta: SubagentProgressDelta): void {
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
        if (!target.internalCalls) target.internalCalls = [];
        target.internalCalls.push(delta.toolCall!);
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
