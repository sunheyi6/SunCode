import type { Message, StreamEvent, ToolCallContent, ToolResult } from '@shared/types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { bridge } from '../api/bridge';
import { completeToolCall, startToolCall } from './tool-call-state';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  toolCalls?: ToolCallContent[];
  timestamp: number;
  isStreaming: boolean;
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

  /**
   * Called when the worker emits a toolStart event with the full ToolCallContent.
   * Creates or updates a running tool call on the current assistant message.
   */
  function startToolExecution(toolCall: ToolCallContent): void {
    const msg = currentAssistantMsg;
    if (!msg) return;
    if (!msg.toolCalls) msg.toolCalls = [];
    startToolCall(msg.toolCalls, toolCall);
  }

  /**
   * Called when the worker emits a toolEnd event.
   * Attaches the completed result to the matching tool call on the current assistant message.
   */
  function endToolExecution(result: ToolResult): void {
    const msg = currentAssistantMsg;
    if (!msg) return;
    if (!msg.toolCalls) msg.toolCalls = [];
    completeToolCall(msg.toolCalls, result);
  }

  function handleStreamEvent(event: StreamEvent): void {
    const msg = currentAssistantMsg;
    if (!msg) return;

    switch (event.type) {
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
        // Message persistence is deferred to the 'done' event so that
        // completed tool calls are included in the saved message.
        break;
      case 'toolcall_start':
        if (!msg.toolCalls) msg.toolCalls = [];
        startToolCall(msg.toolCalls, {
          type: 'tool_call',
          id: event.toolCallId || '',
          name: event.toolName || '',
          arguments: '',
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
        // Tool call argument streaming complete
        break;
      case 'done':
        // Merge tool calls from the worker's final message (repairs any missed live events)
        if (event.message?.toolCalls?.length) {
          if (!msg.toolCalls) msg.toolCalls = [];
          for (const tc of event.message.toolCalls) {
            startToolCall(msg.toolCalls, tc);
            if (tc.result) {
              completeToolCall(msg.toolCalls, tc.result);
            }
          }
        }

        if (!msg.content && event.message) {
          const finalContent = event.message.content;
          if (typeof finalContent === 'string') {
            msg.content = finalContent;
          } else {
            msg.content = finalContent
              .filter((block) => block.type === 'text')
              .map((block) => ('text' in block ? block.text : ''))
              .join('');
          }
        }

        // Build and persist the complete assistant message
        const savedMessage: Message = {
          role: 'assistant',
          content: [
            ...(msg.thinking ? [{ type: 'thinking' as const, text: msg.thinking }] : []),
            { type: 'text' as const, text: msg.content },
          ],
          toolCalls: msg.toolCalls,
        };
        void bridge.saveMessage(savedMessage);

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
    startToolExecution,
    endToolExecution,
    handleStreamEvent,
    finishCurrentResponse,
    clearMessages,
    loadMessages,
  };
});
