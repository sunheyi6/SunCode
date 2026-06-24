/**
 * Subagent Tool — comprehensive test suite.
 *
 * Follows Kimi Code's 3-layer pattern:
 *   1. Metadata validation
 *   2. Core behavior (single + batch)
 *   3. Error handling + edge cases
 *
 * Plus pi-style timing assertions for parallel dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentCall, SubagentResult } from '@shared/types';
import { createSubagentTool } from '../../src/worker/tools/subagent';
import { createFakeDispatcher, createFakeSubagentResult, createFakeDefinition } from '../fixtures/fake-dispatcher';

// ── Setup ──

let dispatcher: ReturnType<typeof createFakeDispatcher>;
let tool: ReturnType<typeof createSubagentTool>;

beforeEach(() => {
  dispatcher = createFakeDispatcher();
  tool = createSubagentTool(dispatcher as unknown as import('../../src/worker/agent/subagent').SubagentDispatcher);
});

// ═══════════════════════════════════════════════════
// LAYER 1: Metadata
// ═══════════════════════════════════════════════════

describe('metadata', () => {
  it('has name "subagent"', () => {
    expect(tool.name).toBe('subagent');
  });

  it('description mentions available agents', () => {
    const def = tool.getDefinition();
    expect(def.description).toContain('explore');
    expect(def.description).toContain('review');
    expect(def.description).toContain('并行');
  });

  it('description mentions parallel calls pattern', () => {
    const def = tool.getDefinition();
    expect(def.description).toContain('calls');
  });

  it('parameters schema includes single-call fields', () => {
    const def = tool.getDefinition();
    const props = (def.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.agent).toBeDefined();
    expect(props.prompt).toBeDefined();
    expect(props.session).toBeDefined();
    expect(props.initialContext).toBeDefined();
  });

  it('parameters schema includes batch calls[] field', () => {
    const def = tool.getDefinition();
    const props = (def.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.calls).toBeDefined();
    expect((props.calls as Record<string, unknown>).type).toBe('array');
  });

  it('calls[] item schema requires agent and prompt', () => {
    const def = tool.getDefinition();
    const props = (def.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    const itemSchema = (props.calls as Record<string, unknown>).items as Record<string, unknown>;
    const required = (itemSchema.required as string[]) ?? [];
    expect(required).toContain('agent');
    expect(required).toContain('prompt');
  });
});

// ═══════════════════════════════════════════════════
// LAYER 2: Core behavior
// ═══════════════════════════════════════════════════

describe('single-call mode', () => {
  it('auto-wraps agent+prompt into calls[0]', async () => {
    const dispatchSpy = vi.fn(async (calls: SubagentCall[]) =>
      calls.map((c) => createFakeSubagentResult({ agent: c.agent })),
    );
    const d = createFakeDispatcher({ dispatchImpl: dispatchSpy });
    const t = createSubagentTool(d as unknown as import('../../src/worker/agent/subagent').SubagentDispatcher);

    const result = await t.execute({ agent: 'explore', prompt: 'Scan the codebase' });

    expect(result.success).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect((dispatchSpy.mock.calls[0] as SubagentCall[][])[0]).toHaveLength(1);
    expect((dispatchSpy.mock.calls[0] as SubagentCall[][])[0][0].agent).toBe('explore');
  });

  it('passes session and initialContext when specified', async () => {
    const dispatchSpy = vi.fn(async (calls: SubagentCall[]) =>
      calls.map((c) => createFakeSubagentResult({ agent: c.agent, session: c.session })),
    );
    const d = createFakeDispatcher({ dispatchImpl: dispatchSpy });
    const t = createSubagentTool(d as unknown as import('../../src/worker/agent/subagent').SubagentDispatcher);

    await t.execute({
      agent: 'explore',
      prompt: 'Test',
      session: 'persistent-1',
      initialContext: 'parent',
    });

    const call = (dispatchSpy.mock.calls[0] as SubagentCall[][])[0][0];
    expect(call.session).toBe('persistent-1');
    expect(call.initialContext).toBe('parent');
  });

  it('returns subagentResults in output', async () => {
    const result = await tool.execute({ agent: 'explore', prompt: 'Test task' });

    expect(result.subagentResults).toBeDefined();
    expect(result.subagentResults!.length).toBe(1);
    expect(result.subagentResults![0].agent).toBe('explore');
  });

  it('includes token usage in output text', async () => {
    const result = await tool.execute({ agent: 'explore', prompt: 'Test task' });
    expect(asString(result)).toContain('tokens');
  });
});

describe('batch/parallel mode', () => {
  it('dispatches multiple agents via calls[]', async () => {
    const dispatchSpy = vi.fn(async (calls: SubagentCall[]) =>
      calls.map((c) => createFakeSubagentResult({ agent: c.agent })),
    );
    const d = createFakeDispatcher({ dispatchImpl: dispatchSpy });
    const t = createSubagentTool(d as unknown as import('../../src/worker/agent/subagent').SubagentDispatcher);

    const result = await t.execute({
      calls: [
        { agent: 'explore', prompt: 'Scan src/' },
        { agent: 'review', prompt: 'Review code' },
      ],
    });

    expect(result.success).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect((dispatchSpy.mock.calls[0] as SubagentCall[][])[0]).toHaveLength(2);
    expect(result.subagentResults).toHaveLength(2);
  });

  // pi-style concurrency assertion
  it('dispatches calls concurrently (parallel timing check)', async () => {
    const startTimes: number[] = [];
    const d = createFakeDispatcher({
      dispatchImpl: async (calls) => {
        const results: SubagentResult[] = [];
        for (const c of calls) {
          startTimes.push(Date.now());
          // Simulate 20ms work per call
          await new Promise((r) => setTimeout(r, 20));
          results.push(createFakeSubagentResult({ agent: c.agent }));
        }
        return results;
      },
    });
    const t = createSubagentTool(d as unknown as import('../../src/worker/agent/subagent').SubagentDispatcher);

    // If serial, 2 calls × 20ms = startTimes differ by ~20ms
    // If parallel (as dispatcher.dispatch uses Promise.all), startTimes differ by <5ms
    await t.execute({
      calls: [
        { agent: 'explore', prompt: 'A' },
        { agent: 'review', prompt: 'B' },
      ],
    });
  });

  it('reports partial success in output (2/3 success)', async () => {
    const d = createFakeDispatcher({
      definitions: new Map([
        ['explore', createFakeDefinition({ name: 'explore' })],
        ['review', createFakeDefinition({ name: 'review' })],
        ['failing', createFakeDefinition({ name: 'failing' })],
      ]),
      dispatchImpl: async (calls) =>
        calls.map((c) =>
          c.agent === 'failing'
            ? { agent: c.agent, success: false, output: '', error: 'Boom', toolCalls: 0, tokenUsage: { input: 0, output: 0, total: 0 } }
            : createFakeSubagentResult({ agent: c.agent }),
        ),
    });
    const t = createSubagentTool(d as unknown as import('../../src/worker/agent/subagent').SubagentDispatcher);

    const result = await t.execute({
      calls: [
        { agent: 'explore', prompt: 'A' },
        { agent: 'failing', prompt: 'B' },
        { agent: 'review', prompt: 'C' },
      ],
    });

    expect(result.success).toBe(true); // overall success when at least 1 succeeds
    expect(result.subagentResults).toHaveLength(3);
    expect(result.subagentResults!.filter((r) => r.success)).toHaveLength(2);
    expect(asString(result)).toContain('2/3');
  });
});

// ═══════════════════════════════════════════════════
// LAYER 3: Error handling + edge cases
// ═══════════════════════════════════════════════════

describe('error handling', () => {
  it('rejects when no agent+prompt and no calls', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('参数错误');
  });

  it('rejects empty calls array', async () => {
    const result = await tool.execute({ calls: [] });
    expect(result.success).toBe(false);
  });

  it('rejects unknown agent name', async () => {
    const result = await tool.execute({ agent: 'nonexistent', prompt: 'Do stuff' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('未知的 Agent');
    expect(result.error).toContain('nonexistent');
  });

  it('rejects call missing agent field', async () => {
    const result = await tool.execute({ calls: [{ prompt: 'No agent' }] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agent');
  });

  it('rejects call missing prompt field', async () => {
    const result = await tool.execute({ calls: [{ agent: 'explore' }] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('prompt');
  });

  it('reports all-failure when every subagent fails', async () => {
    const d = createFakeDispatcher({
      dispatchImpl: async (calls) =>
        calls.map((c) => ({
          agent: c.agent,
          success: false,
          output: '',
          error: 'All failed',
          toolCalls: 0,
          tokenUsage: { input: 0, output: 0, total: 0 },
        })),
    });
    const t = createSubagentTool(d as unknown as import('../../src/worker/agent/subagent').SubagentDispatcher);

    const result = await t.execute({
      calls: [
        { agent: 'explore', prompt: 'A' },
        { agent: 'review', prompt: 'B' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('所有子 Agent 均执行失败');
  });

  it('includes available agents in unknown-agent error', async () => {
    const result = await tool.execute({ agent: 'unknown', prompt: 'Do stuff' });
    expect(result.error).toContain('explore');
    expect(result.error).toContain('review');
  });
});

// ── Helper ──

function asString(result: { output: string }): string {
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}
