// @ts-expect-error Bun provides this module at test runtime; the repo has no Bun type package.
import { describe, expect, test } from 'bun:test';
import type { ToolCallContent } from '@shared/types';
import type { ChatMessage } from '../../stores/chat';
import { buildInlineCallTrace } from './call-trace-view-model';

function commandCall(id: string, command: string): ToolCallContent {
  return {
    type: 'tool_call',
    id,
    name: 'bash',
    arguments: JSON.stringify({ command }),
    status: 'done',
    result: { toolCallId: id, name: 'bash', success: true, output: '' },
  };
}

describe('buildInlineCallTrace', () => {
  test('keeps streamed thinking text instead of replacing it with a generic placeholder', () => {
    const message: ChatMessage = {
      id: 'msg-thinking',
      role: 'assistant',
      content: '',
      blocks: [
        {
          id: 'block-thinking',
          type: 'thinking',
          thinking: 'I should inspect the project structure first.',
        },
      ],
      timestamp: 1,
      isStreaming: true,
      uiLanguage: 'zh',
    };

    const trace = buildInlineCallTrace(message);

    expect(trace.entries[0]).toMatchObject({
      kind: 'thinking',
      text: 'I should inspect the project structure first.',
    });
  });

  test('groups adjacent streamed commands into one process entry', () => {
    const first = commandCall('tool-1', 'pwd');
    const second = commandCall('tool-2', 'ls');
    const message: ChatMessage = {
      id: 'msg-1',
      role: 'assistant',
      content: '',
      toolCalls: [first, second],
      blocks: [
        { id: 'block-1', type: 'tool_call', toolCall: first },
        { id: 'block-2', type: 'tool_call', toolCall: second },
      ],
      timestamp: 1,
      isStreaming: true,
      uiLanguage: 'zh',
    };

    const trace = buildInlineCallTrace(message);

    expect(trace.entries).toHaveLength(1);
    expect(trace.entries[0]).toMatchObject({
      kind: 'tools',
      label: '已运行 2 条命令',
      toolCalls: [first, second],
    });
  });

  test('streamed thinking is not filtered by UI language mismatch (blank-frame regression)', () => {
    // 用户用中文提问 → uiLanguage='zh'；模型常用英文思考。
    // 流式态下按语言过滤会让聊天框完全空白，必须保留原文。
    const message: ChatMessage = {
      id: 'msg-en-thinking',
      role: 'assistant',
      content: '',
      blocks: [
        {
          id: 'block-en-thinking',
          type: 'thinking',
          thinking: 'Now I have a comprehensive understanding of the codebase.',
        },
      ],
      timestamp: 1,
      isStreaming: true,
      uiLanguage: 'zh',
    };

    const trace = buildInlineCallTrace(message);

    expect(trace.entries[0]).toMatchObject({
      kind: 'thinking',
      text: 'Now I have a comprehensive understanding of the codebase.',
    });
  });
});
