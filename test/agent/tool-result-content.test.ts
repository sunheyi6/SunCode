import { describe, expect, test } from 'vitest';
import type { ToolResult } from '../../src/shared/types';
import { formatToolResultForModel } from '../../src/worker/agent/tool-result-content';

describe('formatToolResultForModel', () => {
  test('formats command results as structured JSON with a log field', () => {
    const result: ToolResult = {
      toolCallId: 'tc1',
      name: 'bash',
      success: true,
      output: 'Service started with launcher PID 1234',
      pid: 1234,
      details: {
        type: 'command',
        command: 'cd D:/project/maka-agent; npm run dev',
        cwd: 'D:/project/maka-agent',
        exitCode: null,
        stdout: 'VITE v6.0.0 ready in 100 ms\nLocal: http://localhost:5173/',
        stderr: '',
        expectedPorts: [5173],
        portsReachable: [5173],
      },
    };

    const parsed = JSON.parse(formatToolResultForModel(result)) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      type: 'tool_result',
      tool: 'bash',
      success: true,
      status: 'service_observation',
      command: 'cd D:/project/maka-agent; npm run dev',
      cwd: 'D:/project/maka-agent',
      exitCode: null,
      launcherPid: 1234,
      expectedPorts: [5173],
      portsReachable: [5173],
    });
    expect(parsed.log).toEqual(expect.stringContaining('Service started'));
    expect(parsed.log).toEqual(expect.stringContaining('VITE v6.0.0 ready'));
  });

  test('formats failed tools with structured error information', () => {
    const result: ToolResult = {
      toolCallId: 'tc2',
      name: 'bash',
      success: false,
      output: '',
      error: 'Command failed',
      details: {
        type: 'command',
        command: 'npm test',
        cwd: 'D:/project/SunCode',
        exitCode: 1,
        stdout: '',
        stderr: 'one test failed',
      },
    };

    const parsed = JSON.parse(formatToolResultForModel(result)) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      type: 'tool_result',
      tool: 'bash',
      success: false,
      status: 'command_failed',
      error: 'Command failed',
      stderr: 'one test failed',
    });
    expect(parsed.log).toEqual(expect.stringContaining('one test failed'));
  });
});
