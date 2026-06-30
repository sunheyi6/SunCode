import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test } from 'vitest';
import { useChatStore } from '../../src/renderer/stores/chat';
import type { ToolCallContent } from '../../src/shared/types';

describe('chat store stream blocks', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
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

    expect(store.messages[0]?.blocks).toMatchObject([
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

    expect(store.messages[0]?.blocks).toMatchObject([
      { type: 'thinking', thinking: 'Read first' },
      { type: 'tool_call', toolCall: { id: 'tool-1' } },
      { type: 'thinking', thinking: '\nThen inspect result' },
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

  test('shows a friendly Chinese message for model request timeouts', () => {
    const store = useChatStore();
    store.setActiveSessionId('session-1');
    store.handleStreamEvent({ type: 'message_start' }, 'session-1');

    store.handleStreamEvent({ type: 'error', error: 'Request timed out.' }, 'session-1');

    expect(store.messages[0]?.content).toContain('请求大模型超时');
    expect(store.messages[0]?.content).toContain('稍后重试');
    expect(store.messages[0]?.content).not.toContain('Error: Request timed out.');
  });
});
