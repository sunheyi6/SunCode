/**
 * Fake Tool factory — Kimi Code "fail-by-default" pattern.
 *
 * Creates stub Tool objects where every unimplemented method throws.
 * Tests override only the methods they need, ensuring no silent passes.
 */
import { vi } from 'vitest';
import type { ToolDefinition, ToolResult } from '@shared/types';
import type { Tool } from '../../src/worker/tools/types';

// ── Constants (Kimi Code PERMISSIVE_WORKSPACE / FAKE_OS_ENV pattern) ──

export const FAKE_WORKING_DIR = '/fake/workspace';

export const FAKE_OS_ENV = {
  osName: 'Linux',
  shell: '/bin/bash',
  shellType: 'Bash',
  guidance: 'Unix shell available.',
};

// ── Error factory ──

function notImplemented(method: string): never {
  throw new Error(`FakeTool.${method} not implemented — override in test`);
}

// ── Fake Tool ──

export interface FakeToolOptions {
  name?: string;
  description?: string;
  parameters?: ToolDefinition['parameters'];
  execute?: (params: Record<string, unknown>) => Promise<ToolResult>;
}

export function createFakeTool(opts: FakeToolOptions = {}): Tool {
  const name = opts.name ?? 'fake-tool';
  const description = opts.description ?? 'A fake tool for testing';
  const parameters: ToolDefinition['parameters'] = opts.parameters ?? {
    type: 'object',
    properties: {},
  };

  return {
    name,
    description,
    parameters,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      if (opts.execute) return opts.execute(params);
      // Default success — tests can override with opts.execute
      return {
        toolCallId: '',
        name,
        success: true,
        output: `fake output for: ${JSON.stringify(params)}`,
      };
    },

    getDefinition(): ToolDefinition {
      return { name: this.name, description: this.description, parameters: this.parameters };
    },
  };
}

// ── Fake tools with controllable timing (for concurrency tests) ──

export interface DelayedToolOptions extends FakeToolOptions {
  /** Delay in ms before returning. */
  delay?: number;
  /** Called when execute starts (for recording start order). */
  onStart?: (name: string) => void;
}

export function createDelayedFakeTool(opts: DelayedToolOptions = {}): Tool {
  const startTimes: number[] = [];
  const tool = createFakeTool({
    ...opts,
    execute: async (params) => {
      opts.onStart?.(opts.name ?? 'delayed-tool');
      startTimes.push(Date.now());
      if (opts.delay) {
        await new Promise((r) => setTimeout(r, opts.delay));
      }
      return {
        toolCallId: '',
        name: opts.name ?? 'delayed-tool',
        success: true,
        output: `completed after ${opts.delay ?? 0}ms`,
      };
    },
  });

  return Object.assign(tool, {
    /** Times at which each execute() call started (for concurrency assertions). */
    getStartTimes: () => [...startTimes],
    clearStartTimes: () => { startTimes.length = 0; },
  });
}

// ── Fake tool for spying on execute calls ──

export function createSpyTool(name = 'spy-tool'): Tool & { executeSpy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async (_params: Record<string, unknown>): Promise<ToolResult> => ({
    toolCallId: '',
    name,
    success: true,
    output: 'spy output',
  }));

  const tool = createFakeTool({ name, execute: spy });
  return Object.assign(tool, { executeSpy: spy });
}
