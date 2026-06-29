import { describe, expect, test } from 'vitest';
import { toolActionLabel } from '../../src/renderer/utils/tool-presentation';

describe('toolActionLabel', () => {
  test('labels shell commands as command execution instead of the app name', () => {
    expect(toolActionLabel('bash')).toBe('运行命令');
  });
});
