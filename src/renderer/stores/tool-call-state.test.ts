// @ts-expect-error Bun provides this module at test runtime; the repo has no Bun type package.
import { describe, expect, test } from 'bun:test';
import type { ToolCallContent, ToolResult } from '@shared/types';
import { completeToolCall, startToolCall } from './tool-call-state';

describe('tool call state', () => {
  test('starts a call without duplicating an existing streamed call', () => {
    const calls: ToolCallContent[] = [];
    startToolCall(calls, {
      type: 'tool_call',
      id: 'call-1',
      name: 'edit',
      arguments: '{"file_path":"src/a.ts"}',
    });
    startToolCall(calls, {
      type: 'tool_call',
      id: 'call-1',
      name: 'edit',
      arguments: '{"file_path":"src/a.ts"}',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('running');
  });

  test('attaches a result to the matching call', () => {
    const calls: ToolCallContent[] = [
      { type: 'tool_call', id: 'call-1', name: 'edit', arguments: '', status: 'running' },
    ];
    const result: ToolResult = {
      toolCallId: 'call-1',
      name: 'edit',
      success: true,
      output: '',
    };

    completeToolCall(calls, result);
    expect(calls[0]).toMatchObject({ status: 'done', result });
  });
});
