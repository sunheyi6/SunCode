import { describe, expect, test } from 'vitest';
import {
  formatToolOutputAsMarkdown,
  inferToolOutputLanguage,
  toolActionLabel,
} from '../../src/renderer/utils/tool-presentation';

describe('toolActionLabel', () => {
  test('labels shell commands as command execution instead of the app name', () => {
    expect(toolActionLabel('bash')).toBe('运行命令');
  });
});

describe('inferToolOutputLanguage', () => {
  test('uses the executed command to identify cmd and powershell output', () => {
    expect(inferToolOutputLanguage('dir', 'Volume in drive C is OS')).toBe('cmd');
    expect(inferToolOutputLanguage('Get-ChildItem', 'Mode LastWriteTime Length Name')).toBe(
      'powershell',
    );
  });

  test('detects common structured and programming language outputs', () => {
    expect(inferToolOutputLanguage(undefined, '{"ok": true}')).toBe('json');
    expect(inferToolOutputLanguage(undefined, 'const answer: number = 42;')).toBe('typescript');
    expect(inferToolOutputLanguage(undefined, 'def main():\n    return 42')).toBe('python');
  });

  test('uses file paths to identify read output languages', () => {
    expect(inferToolOutputLanguage('src/App.vue', '<template><main /></template>')).toBe('vue');
    expect(inferToolOutputLanguage('scripts/run.ps1', 'Write-Host "ok"')).toBe('powershell');
  });
});

describe('formatToolOutputAsMarkdown', () => {
  test('wraps output in a fenced markdown code block with the inferred language', () => {
    expect(formatToolOutputAsMarkdown('dir', 'hello')).toBe('```cmd\nhello\n```');
  });

  test('escapes nested markdown fences inside tool output', () => {
    expect(formatToolOutputAsMarkdown(undefined, '```ts\nconst x = 1;\n```')).toContain(
      '``\u200b`ts',
    );
  });
});
