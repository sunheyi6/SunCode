import { describe, expect, test } from 'vitest';
import type { ChatMessage } from '../../src/renderer/stores/chat';
import { buildCallTraceOutline } from '../../src/renderer/components/chat/call-trace-view-model';

describe('buildCallTraceOutline', () => {
  test('groups user requests and assistant model turns into an outline', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'check current implementation',
        timestamp: 10,
        isStreaming: false,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'done',
        timestamp: 20,
        isStreaming: false,
        turnDetails: [
          {
            turnNumber: 1,
            systemTokens: 100,
            requestMessages: [{ role: 'user', length: 28, preview: 'check current implementation' }],
            response: {
              text: '',
              thinking: 'read first',
              toolCalls: [
                {
                  type: 'tool_call',
                  id: 'tc1',
                  name: 'read',
                  arguments: '{"file_path":"src/a.ts"}',
                },
              ],
              inputTokens: 120,
              outputTokens: 30,
              durationMs: 1500,
              stopReason: 'tool_calls',
            },
          },
          {
            turnNumber: 2,
            systemTokens: 100,
            requestMessages: [{ role: 'tool', length: 12, preview: 'file content' }],
            response: {
              text: 'done',
              thinking: '',
              toolCalls: [],
              inputTokens: 140,
              outputTokens: 20,
              durationMs: 800,
              stopReason: 'stop',
            },
          },
        ],
        toolCalls: [
          {
            type: 'tool_call',
            id: 'tc1',
            name: 'read',
            arguments: '{"file_path":"src/a.ts"}',
            status: 'done',
            result: { toolCallId: 'tc1', name: 'read', success: true, output: 'file content' },
          },
        ],
      },
    ];

    const outline = buildCallTraceOutline({ messages, systemPrompt: 'system prompt' });

    expect(outline.systemPrompt?.charCount).toBe(13);
    expect(outline.entries).toHaveLength(3);
    expect(outline.entries[0]).toMatchObject({
      kind: 'user',
      content: 'check current implementation',
    });
    expect(outline.entries[1]).toMatchObject({
      kind: 'turn',
      turnNumber: 1,
      summary: expect.objectContaining({
        toolCount: 1,
        completedToolCount: 1,
        failedToolCount: 0,
        inputTokens: 120,
        outputTokens: 30,
      }),
      sections: expect.arrayContaining([
        expect.objectContaining({ kind: 'input', itemCount: 1, defaultOpen: false }),
        expect.objectContaining({ kind: 'thinking', charCount: 10, defaultOpen: false }),
        expect.objectContaining({ kind: 'tools', itemCount: 1, defaultOpen: false }),
      ]),
    });
    expect(outline.entries[2]).toMatchObject({
      kind: 'turn',
      turnNumber: 2,
      sections: expect.arrayContaining([
        expect.objectContaining({ kind: 'response', charCount: 4, defaultOpen: false }),
      ]),
    });
  });

  test('builds a legacy turn when an assistant message has no turn details', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a-legacy',
        role: 'assistant',
        content: 'old reply',
        thinking: 'old thought',
        timestamp: 1,
        isStreaming: false,
        toolCalls: [
          {
            type: 'tool_call',
            id: 'tc-old',
            name: 'grep',
            arguments: '{"pattern":"trace"}',
            status: 'done',
          },
        ],
      },
    ];

    const outline = buildCallTraceOutline({ messages, systemPrompt: '' });

    expect(outline.entries).toHaveLength(1);
    expect(outline.entries[0]).toMatchObject({
      kind: 'turn',
      turnNumber: 1,
      summary: expect.objectContaining({ toolCount: 1 }),
      sections: expect.arrayContaining([
        expect.objectContaining({ kind: 'thinking', charCount: 11 }),
        expect.objectContaining({ kind: 'tools', itemCount: 1 }),
        expect.objectContaining({ kind: 'response', charCount: 9 }),
      ]),
    });
  });

  test('marks the latest streaming turn and keeps its running tool section open', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a-running',
        role: 'assistant',
        content: '',
        timestamp: 1,
        isStreaming: true,
        turnDetails: [
          {
            turnNumber: 1,
            systemTokens: 50,
            requestMessages: [],
            response: {
              text: '',
              thinking: '',
              toolCalls: [
                {
                  type: 'tool_call',
                  id: 'tc-run',
                  name: 'bash',
                  arguments: '{"command":"npm test"}',
                },
              ],
            },
          },
        ],
        toolCalls: [
          {
            type: 'tool_call',
            id: 'tc-run',
            name: 'bash',
            arguments: '{"command":"npm test"}',
            status: 'running',
          },
        ],
      },
    ];

    const outline = buildCallTraceOutline({ messages, systemPrompt: '' });
    const turn = outline.entries[0];

    expect(turn).toMatchObject({
      kind: 'turn',
      isStreaming: true,
      summary: expect.objectContaining({ completedToolCount: 0, failedToolCount: 0 }),
    });
    expect(turn.kind === 'turn' ? turn.sections : []).toContainEqual(
      expect.objectContaining({ kind: 'tools', defaultOpen: true }),
    );
  });

  test('summarizes mixed successful and failed tools for collapsed rows', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a-tools',
        role: 'assistant',
        content: '',
        timestamp: 1,
        isStreaming: false,
        turnDetails: [
          {
            turnNumber: 1,
            systemTokens: 1,
            requestMessages: [],
            response: {
              text: '',
              thinking: '',
              toolCalls: [
                { type: 'tool_call', id: 'ok', name: 'read', arguments: '{}' },
                { type: 'tool_call', id: 'bad', name: 'bash', arguments: '{}' },
              ],
            },
          },
        ],
        toolCalls: [
          {
            type: 'tool_call',
            id: 'ok',
            name: 'read',
            arguments: '{}',
            status: 'done',
            result: { toolCallId: 'ok', name: 'read', success: true, output: '' },
          },
          {
            type: 'tool_call',
            id: 'bad',
            name: 'bash',
            arguments: '{}',
            status: 'error',
            result: {
              toolCallId: 'bad',
              name: 'bash',
              success: false,
              output: '',
              error: 'failed',
            },
          },
        ],
      },
    ];

    const outline = buildCallTraceOutline({ messages, systemPrompt: '' });

    expect(outline.entries[0]).toMatchObject({
      kind: 'turn',
      summary: expect.objectContaining({
        toolCount: 2,
        completedToolCount: 2,
        failedToolCount: 1,
      }),
    });
  });
});
