/**
 * Fake SubagentDispatcher — Kimi Code "fail-by-default" pattern.
 *
 * Stubs the sub-agent dispatcher for testing the subagent tool and agent loop
 * without executing real sub-agents.
 */
import { vi } from 'vitest';
import type { SubagentCall, SubagentDefinition, SubagentResult } from '@shared/types';
import type { SubagentDispatcher } from '../../src/worker/agent/subagent';

// ── Error factory ──

function notImplemented(method: string): never {
  throw new Error(`FakeDispatcher.${method} not implemented — override in test`);
}

// ── Subagent result factory ──

export function createFakeSubagentResult(overrides?: Partial<SubagentResult>): SubagentResult {
  return {
    agent: 'test-agent',
    success: true,
    output: 'Test agent output',
    toolCalls: 0,
    tokenUsage: { input: 50, output: 30, total: 80 },
    ...overrides,
  };
}

export function createFakeSubagentResultError(agent: string, error: string): SubagentResult {
  return {
    agent,
    success: false,
    output: '',
    error,
    toolCalls: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
  };
}

// ── Subagent definition factory ──

export function createFakeDefinition(overrides?: Partial<SubagentDefinition>): SubagentDefinition {
  return {
    name: 'test-agent',
    description: 'A test sub-agent',
    systemPrompt: 'You are a test agent.',
    allowedTools: ['read', 'write', 'bash'],
    maxTurns: 10,
    model: 'inherit',
    ...overrides,
  };
}

// ── Fake dispatcher ──

export interface FakeDispatcherOptions {
  /** Pre-built definitions (if not provided, defaults to one 'test-agent'). */
  definitions?: Map<string, SubagentDefinition>;
  /** Custom dispatch implementation. Default: returns success for each call. */
  dispatchImpl?: (calls: SubagentCall[]) => Promise<SubagentResult[]>;
  /** Spy on dispatch calls. */
  dispatchSpy?: ReturnType<typeof vi.fn>;
}

export function createFakeDispatcher(opts: FakeDispatcherOptions = {}) {
  const defs = opts.definitions ?? new Map([
    ['test-agent', createFakeDefinition({ name: 'test-agent' })],
    ['explore', createFakeDefinition({ name: 'explore', description: 'Code exploration agent' })],
    ['review', createFakeDefinition({ name: 'review', description: 'Code review agent' })],
  ]);

  const dispatchSpy = opts.dispatchSpy ?? vi.fn();

  const dispatcher = {
    definitions: defs,

    listAgents(): string[] {
      return Array.from(defs.keys());
    },

    getDefinition(name: string): SubagentDefinition | undefined {
      return defs.get(name);
    },

    async dispatch(calls: SubagentCall[]): Promise<SubagentResult[]> {
      dispatchSpy(calls);
      if (opts.dispatchImpl) return opts.dispatchImpl(calls);
      // Default: succeed for all calls
      return calls.map((c) => createFakeSubagentResult({ agent: c.agent, output: `Result from ${c.agent}` }));
    },

    async dispatchOne(_call: SubagentCall): Promise<SubagentResult> {
      return notImplemented('dispatchOne');
    },

    updateOptions(_partial: Record<string, unknown>): void {
      // no-op in fake
    },
  };

  return dispatcher;
}
