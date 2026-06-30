import { describe, expect, test } from 'vitest';
import type { ChatMessage } from '../../src/renderer/stores/chat';
import {
  buildCallTraceOutline,
  buildInlineCallTrace,
  buildSubagentInlineTrace,
} from '../../src/renderer/components/chat/call-trace-view-model';
import type { SubagentResult } from '../../src/shared/types';

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

  test('keeps full request content for trace input display', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a-full-input',
        role: 'assistant',
        content: 'done',
        timestamp: 1,
        isStreaming: false,
        turnDetails: [
          {
            turnNumber: 1,
            systemTokens: 1,
            requestMessages: [
              {
                role: 'tool',
                length: 78,
                preview: '{"type":"tool_result"',
                content:
                  '{"type":"tool_result","tool":"bash","log":"VITE ready on http://localhost:5173"}',
              },
            ],
            response: {
              text: 'done',
              thinking: '',
              toolCalls: [],
            },
          },
        ],
      },
    ];

    const outline = buildCallTraceOutline({ messages, systemPrompt: '' });
    const turn = outline.entries[0];
    const inputSection =
      turn.kind === 'turn' ? turn.sections.find((section) => section.kind === 'input') : undefined;

    expect(inputSection).toMatchObject({
      kind: 'input',
      requestMessages: [
        expect.objectContaining({
          content: expect.stringContaining('"log":"VITE ready'),
        }),
      ],
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

describe('buildInlineCallTrace', () => {
  test('keeps thinking and tool calls in streaming order', () => {
    const message: ChatMessage = {
      id: 'a-inline',
      role: 'assistant',
      content: '',
      thinking: 'read first\nthen continue',
      timestamp: 1,
      isStreaming: true,
      uiLanguage: 'en',
      blocks: [
        { id: 'b1', type: 'thinking', thinking: 'read first' },
        {
          id: 'b2',
          type: 'tool_call',
          toolCall: {
            type: 'tool_call',
            id: 'tc1',
            name: 'bash',
            arguments: '{"command":"Get-Content src/a.ts"}',
          },
        },
        { id: 'b3', type: 'thinking', thinking: '\nthen continue' },
      ],
      toolCalls: [
        {
          type: 'tool_call',
          id: 'tc1',
          name: 'bash',
          arguments: '{"command":"Get-Content src/a.ts"}',
          status: 'done',
          result: { toolCallId: 'tc1', name: 'bash', success: true, output: '' },
        },
      ],
    };

    const trace = buildInlineCallTrace(message);

    expect(trace.entries).toMatchObject([
      { kind: 'thinking', text: 'read first', isCurrent: false },
      { kind: 'tools', label: 'Ran 1 command', isCurrent: false },
      { kind: 'thinking', text: '\nthen continue', isCurrent: true },
    ]);
  });

  test('merges adjacent commands into a compact command count', () => {
    const message: ChatMessage = {
      id: 'a-commands',
      role: 'assistant',
      content: '',
      timestamp: 1,
      isStreaming: false,
      uiLanguage: 'en',
      blocks: [
        {
          id: 'b1',
          type: 'tool_call',
          toolCall: { type: 'tool_call', id: 'tc1', name: 'bash', arguments: '{"command":"one"}' },
        },
        {
          id: 'b2',
          type: 'tool_call',
          toolCall: { type: 'tool_call', id: 'tc2', name: 'bash', arguments: '{"command":"two"}' },
        },
      ],
      toolCalls: [
        { type: 'tool_call', id: 'tc1', name: 'bash', arguments: '{"command":"one"}', status: 'done' },
        { type: 'tool_call', id: 'tc2', name: 'bash', arguments: '{"command":"two"}', status: 'done' },
      ],
    };

    const trace = buildInlineCallTrace(message);

    expect(trace.entries).toMatchObject([
      { kind: 'tools', label: 'Ran 2 commands', isCurrent: false },
    ]);
  });

  test('falls back to message-level thinking and tool calls without blocks', () => {
    const message: ChatMessage = {
      id: 'a-fallback',
      role: 'assistant',
      content: '',
      thinking: 'fallback thinking',
      timestamp: 1,
      isStreaming: false,
      uiLanguage: 'en',
      toolCalls: [
        {
          type: 'tool_call',
          id: 'tc1',
          name: 'read',
          arguments: '{"file_path":"src/a.ts"}',
          status: 'running',
        },
      ],
    };

    const trace = buildInlineCallTrace(message);

    expect(trace.entries).toMatchObject([
      { kind: 'thinking', text: 'fallback thinking' },
      { kind: 'tools', label: 'Running 1 tool' },
    ]);
  });

  test('keeps agents, tools, and commands in separate fallback groups', () => {
    const message: ChatMessage = {
      id: 'a-mixed',
      role: 'assistant',
      content: '',
      timestamp: 1,
      isStreaming: true,
      uiLanguage: 'en',
      toolCalls: [
        {
          type: 'tool_call',
          id: 'agent-1',
          name: 'subagent',
          arguments: '{"agent":"explore","prompt":"inspect"}',
          status: 'done',
        },
        {
          type: 'tool_call',
          id: 'read-1',
          name: 'read',
          arguments: '{"file_path":"src/a.ts"}',
          status: 'done',
        },
        {
          type: 'tool_call',
          id: 'bash-1',
          name: 'bash',
          arguments: '{"command":"bun test"}',
          status: 'running',
        },
      ],
    };

    const trace = buildInlineCallTrace(message);

    expect(trace.entries).toMatchObject([
      { kind: 'tools', label: 'Ran 1 agent' },
      { kind: 'tools', label: 'Ran 1 tool' },
      { kind: 'tools', label: 'Running 1 command' },
    ]);
  });

  test('does not show English thinking text for a Chinese UI language', () => {
    const message: ChatMessage = {
      id: 'a-language',
      role: 'assistant',
      content: '',
      thinking: 'Read files and inspect the result.',
      timestamp: 1,
      isStreaming: true,
      uiLanguage: 'zh',
      blocks: [
        { id: 'b1', type: 'thinking', thinking: 'Read files and inspect the result.' },
      ],
    };

    const trace = buildInlineCallTrace(message);

    expect(trace.entries).toMatchObject([
      { kind: 'thinking', text: '正在分析下一步。' },
    ]);
  });
});

describe('buildSubagentInlineTrace', () => {
  test('keeps subagent thinking and internal tools in streaming order', () => {
    const result: SubagentResult = {
      agent: 'explore',
      success: true,
      output: '执行中...',
      toolCalls: 1,
      tokenUsage: { input: 0, output: 0, total: 0 },
      thinking: 'Read first\nThen inspect result',
      internalCalls: [
        {
          type: 'tool_call',
          id: 'read-1',
          name: 'read',
          arguments: '{"file_path":"src/a.ts"}',
          status: 'running',
        },
      ],
      internalBlocks: [
        { id: 'b1', type: 'thinking', thinking: 'Read first' },
        {
          id: 'b2',
          type: 'tool_call',
          toolCall: {
            type: 'tool_call',
            id: 'read-1',
            name: 'read',
            arguments: '{"file_path":"src/a.ts"}',
          },
        },
        { id: 'b3', type: 'thinking', thinking: '\nThen inspect result' },
      ],
    };

    const trace = buildSubagentInlineTrace(result, true, 'en');

    expect(trace.entries).toMatchObject([
      { kind: 'thinking', text: 'Read first', isCurrent: false },
      { kind: 'tools', label: 'Running 1 tool', isCurrent: false },
      { kind: 'thinking', text: '\nThen inspect result', isCurrent: true },
    ]);
  });
});
