// @ts-expect-error Bun provides this module at test runtime; the repo has no Bun type package.
import { describe, expect, test } from 'bun:test';
import type { Message, ToolCallContent } from '@shared/types';
import { buildPersistedAssistantMessage } from './chat-message-persistence';

describe('chat message persistence', () => {
  test('uses final done content instead of streamed placeholder text', () => {
    const finalMessage: Message = {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'worked through the bug' },
        { type: 'text', text: 'Final answer with verification evidence.' },
      ],
    };

    const persisted = buildPersistedAssistantMessage({
      visibleContent: '处理中...',
      thinking: '',
      toolCalls: [],
      finalMessage,
    });

    expect(persisted.content).toEqual(finalMessage.content);
  });

  test('persists completed tool calls with the final assistant message', () => {
    const toolCalls: ToolCallContent[] = [
      {
        type: 'tool_call',
        id: 'call-1',
        name: 'bash',
        arguments: '{"command":"bun test"}',
        status: 'done',
        result: {
          toolCallId: 'call-1',
          name: 'bash',
          success: true,
          output: 'pass',
        },
      },
    ];

    const persisted = buildPersistedAssistantMessage({
      visibleContent: 'Final answer.',
      thinking: 'reasoning',
      toolCalls,
    });

    expect(persisted.toolCalls).toEqual(toolCalls);
    expect(persisted.content).toEqual([
      { type: 'thinking', text: 'reasoning' },
      { type: 'text', text: 'Final answer.' },
    ]);
  });
});
