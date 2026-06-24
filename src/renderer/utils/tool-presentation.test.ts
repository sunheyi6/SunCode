// @ts-expect-error Bun provides this module at test runtime; the repo has no Bun type package.
import { describe, expect, test } from 'bun:test';
import type { ToolCallContent } from '@shared/types';
import { commandSummary, fileOperationView, parseToolArguments } from './tool-presentation';

describe('tool presentation', () => {
  test('parses complete arguments and tolerates partial JSON', () => {
    expect(parseToolArguments('{"file_path":"src/a.ts"}')).toEqual({
      file_path: 'src/a.ts',
    });
    expect(parseToolArguments('{"file_path":')).toEqual({});
  });

  test('shows editing while an edit call is running', () => {
    const call: ToolCallContent = {
      type: 'tool_call',
      id: '1',
      name: 'edit',
      arguments: '{"file_path":"src/a.ts"}',
      status: 'running',
    };
    expect(fileOperationView(call)).toMatchObject({
      filePath: 'src/a.ts',
      label: '编辑中',
    });
  });

  test('uses description before a shortened command', () => {
    expect(commandSummary({ command: 'bun run build', description: '构建应用' })).toBe('构建应用');
    expect(commandSummary({ command: 'bun run build' })).toBe('bun run build');
  });
});
