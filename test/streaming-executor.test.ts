import { describe, expect, test } from 'vitest';
import type { RunEvent, ToolDefinition, ToolResult } from '@shared/types';
import { StreamingToolExecutor } from '../src/worker/agent/streaming-executor';
import type { Tool } from '../src/worker/tools/types';

class FakeReadonlyTool implements Tool {
  readonly name = 'fake';
  readonly description = 'fake readonly tool';
  readonly parameters: ToolDefinition['parameters'] = {
    type: 'object',
    properties: {},
  };
  readonly isReadonly = true;
  onProgress: ((chunk: string) => void) | null = null;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
  }

  async execute(): Promise<ToolResult> {
    this.onProgress?.('live output\n');
    return {
      toolCallId: '',
      name: this.name,
      success: false,
      output: 'failed output',
      error: 'failed intentionally',
    };
  }
}

class FakeWriteTool implements Tool {
  readonly name = 'write_fake';
  readonly description = 'fake mutating tool';
  readonly parameters: ToolDefinition['parameters'] = {
    type: 'object',
    properties: {},
  };
  readonly isReadonly = false;
  onProgress: ((chunk: string) => void) | null = null;
  executeCount = 0;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
  }

  async execute(): Promise<ToolResult> {
    this.executeCount++;
    return {
      toolCallId: '',
      name: this.name,
      success: true,
      output: 'mutated',
    };
  }
}

describe('StreamingToolExecutor', () => {
  test('emits run events for pre-executed tools including failure status', async () => {
    const events: RunEvent[] = [];
    const executor = new StreamingToolExecutor([new FakeReadonlyTool()], process.cwd(), false, {
      runId: 'run-1',
      onRunEvent: (event) => events.push(event),
    });

    executor.onToolCallComplete({
      type: 'tool_call',
      id: 'call-1',
      name: 'fake',
      arguments: '{}',
    });

    await executor.collectAllResults();

    expect(events).toMatchObject([
      {
        type: 'tool_started',
        toolCallId: 'call-1',
        toolName: 'fake',
      },
      {
        type: 'tool_completed',
        toolCallId: 'call-1',
        toolName: 'fake',
        success: false,
        error: 'failed intentionally',
      },
    ]);
  });

  test('does not pre-execute mutating tools while streaming', async () => {
    const tool = new FakeWriteTool();
    const executor = new StreamingToolExecutor([tool], process.cwd(), false);

    executor.onToolCallComplete({
      type: 'tool_call',
      id: 'call-1',
      name: 'write_fake',
      arguments: '{}',
    });

    const results = await executor.collectAllResults();

    expect(results).toEqual([]);
    expect(tool.executeCount).toBe(0);
  });
});
