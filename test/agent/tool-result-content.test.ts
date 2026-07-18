import { describe, expect, test } from 'vitest';
import type { ToolResult } from '../../src/shared/types';
import { formatToolResultForModel } from '../../src/worker/agent/tool-result-content';

describe('formatToolResultForModel', () => {
  test('formats command results without a redundant log field', () => {
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
      kind: 'command',
      success: true,
      status: 'service_observation',
      command: 'cd D:/project/maka-agent; npm run dev',
      cwd: 'D:/project/maka-agent',
      exitCode: null,
      launcherPid: 1234,
      expectedPorts: [5173],
      portsReachable: [5173],
    });
    // Short observation body; stdout adds facts not already in output
    expect(parsed.output).toEqual(expect.stringContaining('Service started'));
    expect(parsed.stdout).toEqual(expect.stringContaining('VITE v6.0.0 ready'));
    expect(parsed.log).toBeUndefined();
  });

  test('omits stdout/stderr when already fully present in output', () => {
    const stdout = 'build ok\n';
    const result: ToolResult = {
      toolCallId: 'tc-dup',
      name: 'bash',
      success: true,
      output: `Command: npm run build\nExit code: 0\n\nSTDOUT:\n${stdout}`,
      details: {
        type: 'command',
        command: 'npm run build',
        cwd: 'D:/project/SunCode',
        exitCode: 0,
        stdout,
        stderr: '',
      },
    };

    const parsed = JSON.parse(formatToolResultForModel(result)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      kind: 'command',
      status: 'command_completed',
      exitCode: 0,
    });
    expect(parsed.stdout).toBeUndefined();
    expect(parsed.stderr).toBeUndefined();
    expect(parsed.log).toBeUndefined();
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
      kind: 'command',
      success: false,
      status: 'command_failed',
      error: 'Command failed',
      stderr: 'one test failed',
    });
    expect(parsed.log).toBeUndefined();
  });

  test('adds truncation recovery metadata when fullOutputPath is present', () => {
    const result: ToolResult = {
      toolCallId: 'tc3',
      name: 'bash',
      success: true,
      output: 'Command: long-job\nExit code: 0\n\nSTDOUT:\n... (100 earlier lines skipped)\ntail',
      details: {
        type: 'command',
        command: 'long-job',
        cwd: 'D:/project/SunCode',
        exitCode: 0,
        stdout: '... (100 earlier lines skipped)\ntail',
        stderr: '',
        fullOutputPath: 'C:/tmp/suncode-bash-abc.log',
      },
    };

    const parsed = JSON.parse(formatToolResultForModel(result)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      kind: 'command',
      truncated: true,
      kept: 'tail',
      fullOutputPath: 'C:/tmp/suncode-bash-abc.log',
    });
    expect(typeof parsed.recoveryHint).toBe('string');
    expect(parsed.recoveryHint).toEqual(expect.stringContaining('C:/tmp/suncode-bash-abc.log'));
  });

  test('projects file_edit details for the model', () => {
    const result: ToolResult = {
      toolCallId: 'tc4',
      name: 'edit',
      success: true,
      output: 'Edited src/foo.ts (+2/-1)',
      details: {
        type: 'file_edit',
        filePath: 'D:/project/SunCode/src/foo.ts',
        status: 'edited',
        addedLines: 2,
        removedLines: 1,
      },
    };

    const parsed = JSON.parse(formatToolResultForModel(result)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      type: 'tool_result',
      tool: 'edit',
      kind: 'file_edit',
      success: true,
      filePath: 'D:/project/SunCode/src/foo.ts',
      editStatus: 'edited',
      addedLines: 2,
      removedLines: 1,
    });
  });
});
