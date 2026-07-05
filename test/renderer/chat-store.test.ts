import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { useChatStore } from '../../src/renderer/stores/chat';
import type { Message, ToolCallContent } from '../../src/shared/types';

const saveMessageMock = vi.fn();

function blockSummary(
  blocks: NonNullable<ReturnType<typeof useChatStore>['messages'][number]['blocks']> | undefined,
) {
  return (blocks ?? []).map((block) => ({
    type: block.type,
    thinking: block.thinking,
    text: block.text,
    toolCall: block.toolCall
      ? { id: block.toolCall.id, status: block.toolCall.status }
      : undefined,
  }));
}

describe('chat store stream blocks', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    saveMessageMock.mockReset();
    saveMessageMock.mockResolvedValue(undefined);
    (globalThis as typeof globalThis & { window: Window }).window = {
      suncode: {
        saveMessage: saveMessageMock,
      } as unknown as NonNullable<Window['suncode']>,
    } as unknown as Window;
  });

  test('merges consecutive thinking deltas into a single block', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');

    store.handleStreamEvent(
      { type: 'message_update', data: { text: '', thinking: 'The', toolCalls: [] } },
      'session-1',
    );
    store.handleStreamEvent(
      { type: 'message_update', data: { text: '', thinking: 'The user', toolCalls: [] } },
      'session-1',
    );

    expect(blockSummary(store.messages[0]?.blocks)).toEqual([
      { type: 'thinking', thinking: 'The user' },
    ]);
  });

  test('starts a new thinking block after a tool call block', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');

    store.handleStreamEvent(
      { type: 'message_update', data: { text: '', thinking: 'Read first', toolCalls: [] } },
      'session-1',
    );
    store.handleStreamEvent(
      {
        type: 'message_update',
        data: {
          text: '',
          thinking: 'Read first',
          toolCalls: [
            {
              type: 'tool_call',
              id: 'tool-1',
              name: 'read',
              arguments: '{"file_path":"src/a.ts"}',
            },
          ],
        },
      },
      'session-1',
    );
    store.handleStreamEvent(
      {
        type: 'message_update',
        data: {
          text: '',
          thinking: 'Read first\nThen inspect result',
          toolCalls: [
            {
              type: 'tool_call',
              id: 'tool-1',
              name: 'read',
              arguments: '{"file_path":"src/a.ts"}',
            },
          ],
        },
      },
      'session-1',
    );

    expect(blockSummary(store.messages[0]?.blocks)).toEqual([
      { type: 'thinking', thinking: 'Read first' },
      { type: 'tool_call', toolCall: { id: 'tool-1' } },
      { type: 'thinking', thinking: '\nThen inspect result' },
    ]);
  });

  test('keeps answer fragments between thinking and tool call blocks', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');

    store.handleStreamEvent(
      { type: 'message_update', data: { text: '', thinking: 'Think first', toolCalls: [] } },
      'session-1',
    );
    store.handleStreamEvent(
      {
        type: 'message_update',
        data: { text: 'Here is what I found.', thinking: 'Think first', toolCalls: [] },
      },
      'session-1',
    );
    store.handleStreamEvent(
      {
        type: 'message_update',
        data: {
          text: 'Here is what I found.',
          thinking: 'Think first',
          toolCalls: [
            {
              type: 'tool_call',
              id: 'tool-1',
              name: 'read',
              arguments: '{"file_path":"src/a.ts"}',
            },
          ],
        },
      },
      'session-1',
    );

    expect(store.messages[0]?.content).toBe('Here is what I found.');
    expect(blockSummary(store.messages[0]?.blocks)).toEqual([
      { type: 'thinking', thinking: 'Think first' },
      { type: 'text', text: 'Here is what I found.' },
      { type: 'tool_call', toolCall: { id: 'tool-1' } },
    ]);
  });

  test('replaces the current turn text when the final stream snapshot is shorter', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');
    store.handleStreamEvent({ type: 'turn_start', turnCount: 1, maxTurns: 5 }, 'session-1');
    store.handleStreamEvent(
      {
        type: 'message_update',
        data: {
          text: '{\n  "type": "suncode.message",\n  "content": {\n    "text": "完成"',
          thinking: '',
          toolCalls: [],
        },
      },
      'session-1',
    );
    store.handleStreamEvent(
      {
        type: 'message_update',
        data: { text: '完成', thinking: '', toolCalls: [] },
      },
      'session-1',
    );

    expect(store.messages[0]?.content).toBe('完成');
    expect(blockSummary(store.messages[0]?.blocks)).toEqual([{ type: 'text', text: '完成' }]);
  });

  test('keeps previous turn text when replacing the current turn text', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');
    store.handleStreamEvent({ type: 'turn_start', turnCount: 1, maxTurns: 5 }, 'session-1');
    store.handleStreamEvent(
      { type: 'message_update', data: { text: '先检查。', thinking: '', toolCalls: [] } },
      'session-1',
    );
    store.handleStreamEvent({ type: 'turn_start', turnCount: 2, maxTurns: 5 }, 'session-1');
    store.handleStreamEvent(
      { type: 'message_update', data: { text: 'raw leaked protocol text', thinking: '', toolCalls: [] } },
      'session-1',
    );
    store.handleStreamEvent(
      {
        type: 'message_update',
        data: { text: '已完成。', thinking: '', toolCalls: [] },
      },
      'session-1',
    );

    expect(store.messages[0]?.content).toBe('先检查。已完成。');
    expect(blockSummary(store.messages[0]?.blocks)).toEqual([
      { type: 'text', text: '先检查。' },
      { type: 'text', text: '已完成。' },
    ]);
  });

  test('waits for final message before persisting assistant content', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');
    store.handleStreamEvent({ type: 'turn_start', turnCount: 1, maxTurns: 5 }, 'session-1');
    store.handleStreamEvent(
      { type: 'message_update', data: { text: '我先看看。', thinking: '', toolCalls: [] } },
      'session-1',
    );
    store.handleStreamEvent({ type: 'turn_start', turnCount: 2, maxTurns: 5 }, 'session-1');
    store.handleStreamEvent(
      { type: 'message_update', data: { text: '最终回答。', thinking: '', toolCalls: [] } },
      'session-1',
    );

    store.handleStreamEvent(
      {
        type: 'message_end',
        data: { text: '最终回答。', thinking: '', toolCalls: [], isFinished: true },
      },
      'session-1',
    );

    expect(store.messages[0]?.content).toBe('我先看看。最终回答。');
    expect(saveMessageMock).not.toHaveBeenCalled();

    const finalMessage: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: '最终回答。' }],
    };
    store.handleStreamEvent({ type: 'message_end', message: finalMessage }, 'session-1');

    expect(store.messages[0]?.content).toBe('最终回答。');
    expect(saveMessageMock).toHaveBeenCalledOnce();
    expect(saveMessageMock.mock.calls[0]?.[0]).toMatchObject({
      role: 'assistant',
      content: finalMessage.content,
    });
  });

  test('unwraps structured final content before displaying and persisting it', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');

    const leaked = JSON.stringify({
      type: 'suncode.message',
      version: 1,
      role: 'assistant',
      content: { text: '## Done\n\n- formatted item' },
    });
    const finalMessage: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: leaked }],
    };

    store.handleStreamEvent({ type: 'message_end', message: finalMessage }, 'session-1');

    expect(store.messages[0]?.content).toBe('## Done\n\n- formatted item');
    expect(saveMessageMock).toHaveBeenCalledOnce();
    expect(saveMessageMock.mock.calls[0]?.[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '## Done\n\n- formatted item' }],
    });
  });

  test('creates a tool block even if tool execution starts before the stream snapshot arrives', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');

    const toolCall: ToolCallContent = {
      type: 'tool_call',
      id: 'tool-1',
      name: 'read',
      arguments: '{"file_path":"src/a.ts"}',
    };
    store.startToolExecution(toolCall, 'session-1');
    store.handleStreamEvent(
      {
        type: 'message_update',
        data: { text: '', thinking: '', toolCalls: [toolCall] },
      },
      'session-1',
    );

    expect(blockSummary(store.messages[0]?.blocks)).toEqual([
      { type: 'tool_call', toolCall: { id: 'tool-1', status: 'running' } },
    ]);
  });

  test('starts a fresh thinking cursor for each model turn in the same assistant message', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');
    store.handleStreamEvent({ type: 'turn_start', turnCount: 1, maxTurns: 5 }, 'session-1');
    store.handleStreamEvent(
      { type: 'message_update', data: { text: '', thinking: 'First turn thinking', toolCalls: [] } },
      'session-1',
    );
    store.handleStreamEvent(
      {
        type: 'message_update',
        data: {
          text: '',
          thinking: 'First turn thinking',
          toolCalls: [
            {
              type: 'tool_call',
              id: 'tool-1',
              name: 'read',
              arguments: '{"file_path":"src/a.ts"}',
            },
          ],
        },
      },
      'session-1',
    );

    store.handleStreamEvent({ type: 'turn_start', turnCount: 2, maxTurns: 5 }, 'session-1');
    store.handleStreamEvent(
      { type: 'message_update', data: { text: '', thinking: 'Second turn thinking', toolCalls: [] } },
      'session-1',
    );

    expect(blockSummary(store.messages[0]?.blocks)).toEqual([
      { type: 'thinking', thinking: 'First turn thinking' },
      { type: 'tool_call', toolCall: { id: 'tool-1' } },
      { type: 'thinking', thinking: 'Second turn thinking' },
    ]);
  });

  test('keeps command progress inside the tool call instead of the assistant body', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');

    const toolCall: ToolCallContent = {
      type: 'tool_call',
      id: 'bash-1',
      name: 'bash',
      arguments: '{"command":"npm test"}',
    };
    store.startToolExecution(toolCall, 'session-1');
    store.updateToolProgress('bash-1', 'running output', 'session-1');

    expect(store.messages[0]?.toolCalls?.[0]?.partialOutput).toBe('running output');
    expect('liveCommandOutput' in (store.messages[0] ?? {})).toBe(false);
  });

  test('derives assistant UI language from the user message', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');

    store.addUserMessage('请检查这个问题');
    store.startAssistantMessage();

    expect(store.messages[0]?.uiLanguage).toBe('zh');
    expect(store.messages[1]?.uiLanguage).toBe('zh');
  });

  test('keeps subagent progress as ordered internal trace blocks', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');

    const subagentCall: ToolCallContent = {
      type: 'tool_call',
      id: 'subagent-1',
      name: 'subagent',
      arguments: '{"agent":"explore","prompt":"inspect code"}',
    };
    const internalCall: ToolCallContent = {
      type: 'tool_call',
      id: 'read-1',
      name: 'read',
      arguments: '{"file_path":"src/a.ts"}',
    };

    store.startToolExecution(subagentCall, 'session-1');
    store.handleSubagentProgress(
      'exec-1',
      'explore',
      { type: 'thinking', text: 'Read first' },
      'session-1',
    );
    store.handleSubagentProgress(
      'exec-1',
      'explore',
      { type: 'tool_start', toolCall: { ...internalCall, status: 'running' } },
      'session-1',
    );
    store.handleSubagentProgress(
      'exec-1',
      'explore',
      { type: 'thinking', text: '\nThen inspect result' },
      'session-1',
    );
    store.handleSubagentProgress(
      'exec-1',
      'explore',
      {
        type: 'tool_end',
        toolResult: { toolCallId: 'read-1', name: 'read', success: true, output: 'content' },
      },
      'session-1',
    );

    const result = store.messages[0]?.toolCalls?.[0]?.result?.subagentResults?.[0];

    expect(blockSummary(result?.internalBlocks)).toEqual([
      { type: 'thinking', thinking: 'Read first' },
      { type: 'tool_call', toolCall: { id: 'read-1', status: 'done' } },
      { type: 'thinking', thinking: '\nThen inspect result' },
    ]);
  });

  test('shows a friendly Chinese message for model request timeouts', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');

    store.handleStreamEvent({ type: 'error', error: 'Request timed out.' }, 'session-1');

    expect(store.messages[0]?.content).toContain('请求大模型超时');
    expect(store.messages[0]?.content).toContain('稍后重试');
    expect(store.messages[0]?.content).not.toContain('Error: Request timed out.');
  });

  test('parses streamed task plans that use an ASCII colon marker', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');

    store.handleStreamEvent(
      {
        type: 'message_update',
        data: {
          text: '📋 执行计划:\n- [ ] Step 1: 定位计划展示链路\n- [ ] Step 2: 同步当前任务状态',
          thinking: '',
          toolCalls: [],
        },
      },
      'session-1',
    );

    expect(store.messages[0]?.taskPlan?.taskType).toBe('execution');
    expect(store.messages[0]?.taskPlan?.steps[0]).toMatchObject({
      index: 1,
      description: '定位计划展示链路',
      status: 'pending',
    });
    expect(store.messages[0]?.taskPlan?.steps[1]).toMatchObject({
      index: 2,
      description: '同步当前任务状态',
      status: 'pending',
    });
  });
});
