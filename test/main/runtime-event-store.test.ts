import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import {
  createSessionRuntimeProjector,
  projectSessionRuntime,
} from '../../src/main/runtime-projector';
import type { Message } from '../../src/shared/types';

const appDataDir = await mkdtemp(join(tmpdir(), 'suncode-runtime-events-'));
vi.doMock('../../src/main/paths', () => ({ getAppDataDir: () => appDataDir }));

const {
  appendRuntimeEvent,
  clearRuntimePartial,
  flushRuntimePartial,
  initializeRuntimeLedger,
  isRuntimeInvocationClosedError,
  readRuntimeEvents,
  readRuntimePartial,
  RuntimeInvocationClosedError,
  scheduleRuntimePartial,
} = await import('../../src/main/runtime-event-store');

afterAll(async () => {
  await rm(appDataDir, { recursive: true, force: true });
});

describe('Runtime Event Log', () => {
  test('imports a legacy snapshot once and builds an ordered replayable ledger', async () => {
    const sessionId = 'ordered-session';
    const legacy: Message[] = [{ role: 'assistant', content: 'old answer' }];
    await initializeRuntimeLedger(sessionId, legacy);

    await Promise.all([
      appendRuntimeEvent(sessionId, {
        eventId: 'run-1:user',
        runId: 'run-1',
        turnId: 'turn-1',
        invocationId: 'run-1',
        fact: {
          type: 'user_message_committed',
          source: 'dispatch',
          message: { role: 'user', content: 'new question' },
        },
      }),
      appendRuntimeEvent(sessionId, {
        eventId: 'run-1:assistant',
        runId: 'run-1',
        turnId: 'turn-1',
        invocationId: 'run-1',
        fact: {
          type: 'assistant_message_committed',
          message: { role: 'assistant', content: 'new answer' },
        },
      }),
    ]);
    await appendRuntimeEvent(sessionId, {
      eventId: 'run-1:terminal',
      runId: 'run-1',
      turnId: 'turn-1',
      invocationId: 'run-1',
      fact: { type: 'invocation_terminated', status: 'completed' },
    });

    const events = await readRuntimeEvents(sessionId);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events[2]?.previousEventId).toBe(events[1]?.eventId);
    expect(projectSessionRuntime(events).messages.map((message) => message.content)).toEqual([
      'old answer',
      'new question',
      'new answer',
    ]);

    const incremental = createSessionRuntimeProjector();
    incremental.append(events.slice(0, 2));
    expect(incremental.append(events.slice(2))).toEqual(projectSessionRuntime(events));
  });

  test('coalesces duplicate terminal facts and rejects conflicting outcomes', async () => {
    const sessionId = 'terminal-session';
    const completed = await appendRuntimeEvent(sessionId, {
      eventId: 'run-2:terminal',
      runId: 'run-2',
      turnId: 'turn-2',
      invocationId: 'run-2',
      fact: { type: 'invocation_terminated', status: 'completed' },
    });
    const duplicate = await appendRuntimeEvent(sessionId, {
      eventId: 'run-2:terminal-duplicate',
      runId: 'run-2',
      turnId: 'turn-2',
      invocationId: 'run-2',
      fact: { type: 'invocation_terminated', status: 'completed' },
    });

    expect(duplicate.eventId).toBe(completed.eventId);
    await expect(
      appendRuntimeEvent(sessionId, {
        eventId: 'run-2:terminal-conflict',
        runId: 'run-2',
        turnId: 'turn-2',
        invocationId: 'run-2',
        fact: { type: 'invocation_terminated', status: 'failed' },
      }),
    ).rejects.toBeInstanceOf(RuntimeInvocationClosedError);
    try {
      await appendRuntimeEvent(sessionId, {
        eventId: 'run-2:late-assistant',
        runId: 'run-2',
        turnId: 'turn-2',
        invocationId: 'run-2',
        fact: {
          type: 'assistant_message_committed',
          message: { role: 'assistant', content: 'late result' },
        },
      });
      throw new Error('expected closed invocation error');
    } catch (error) {
      expect(isRuntimeInvocationClosedError(error)).toBe(true);
      if (isRuntimeInvocationClosedError(error)) {
        expect(error.existingStatus).toBe('completed');
      }
    }
  });

  test('projects call trace and tool state without reading renderer state', async () => {
    const sessionId = 'projection-session';
    const base = { runId: 'run-3', turnId: 'turn-3', invocationId: 'run-3' };
    await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-3:system',
      fact: { type: 'system_prompt_committed', systemPrompt: 'system prompt' },
    });
    await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-3:model',
      fact: {
        type: 'model_step_committed',
        stepIndex: 1,
        attempt: 1,
        provider: 'test',
        model: 'model',
        requestMessages: [],
        systemTokens: 3,
        responseText: '',
        responseThinking: 'thinking',
        responseToolCalls: [{ type: 'tool_call', id: 'call-1', name: 'read', arguments: '{}' }],
      },
    });
    await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-3:tool-call',
      fact: {
        type: 'tool_call_committed',
        toolCall: { type: 'tool_call', id: 'call-1', name: 'read', arguments: '{}' },
      },
    });
    await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-3:tool-result',
      fact: {
        type: 'tool_result_committed',
        toolResult: { toolCallId: 'call-1', name: 'read', success: true, output: 'contents' },
      },
    });
    await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-3:assistant',
      fact: {
        type: 'assistant_message_committed',
        message: { role: 'assistant', content: 'finished' },
      },
    });

    const message = projectSessionRuntime(await readRuntimeEvents(sessionId)).messages.at(-1);
    expect(message).toMatchObject({
      role: 'assistant',
      content: 'finished',
      systemPrompt: 'system prompt',
      toolCalls: [{ id: 'call-1', status: 'done', result: { output: 'contents' } }],
      turnDetails: [{ turnNumber: 1, systemTokens: 3 }],
    });
  });

  test('records multiple system-prompt updates within one run; projection keeps the latest', async () => {
    const sessionId = 'sysprompt-update-session';
    const base = { runId: 'run-sys', turnId: 'turn-sys', invocationId: 'run-sys' };
    // Content-addressed event IDs: changed payload → new event, no collision.
    await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-sys:system-prompt:aaaa1111',
      fact: { type: 'system_prompt_committed', systemPrompt: 'first prompt' },
    });
    await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-sys:system-prompt:bbbb2222',
      fact: { type: 'system_prompt_committed', systemPrompt: 'second prompt' },
    });
    await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-sys:assistant',
      fact: {
        type: 'assistant_message_committed',
        message: { role: 'assistant', content: 'done' },
      },
    });

    const events = await readRuntimeEvents(sessionId);
    expect(events.filter((event) => event.fact.type === 'system_prompt_committed')).toHaveLength(2);
    const message = projectSessionRuntime(events).messages.at(-1);
    expect(message).toMatchObject({ role: 'assistant', content: 'done', systemPrompt: 'second prompt' });
  });

  test('keeps streaming output in one replaceable partial snapshot', async () => {
    const sessionId = 'partial-session';
    scheduleRuntimePartial({
      sessionId,
      runId: 'run-partial',
      turnId: 'turn-partial',
      updatedAt: '2026-07-02T10:00:00.000Z',
      data: { text: 'first', thinking: '', toolCalls: [] },
    });
    scheduleRuntimePartial({
      sessionId,
      runId: 'run-partial',
      turnId: 'turn-partial',
      updatedAt: '2026-07-02T10:00:01.000Z',
      data: { text: 'latest', thinking: 'reasoning', toolCalls: [] },
    });
    await flushRuntimePartial(sessionId, 'run-partial');

    expect(await readRuntimePartial(sessionId, 'run-partial')).toMatchObject({
      data: { text: 'latest', thinking: 'reasoning' },
    });
    await clearRuntimePartial(sessionId, 'run-partial');
    expect(await readRuntimePartial(sessionId, 'run-partial')).toBeNull();
  });

  test('records compaction replacement so the model view is replayable; projection keeps messages untouched', async () => {
    const sessionId = 'compaction-session';
    const base = { runId: 'run-compact', turnId: 'turn-compact', invocationId: 'run-compact' };
    const projectionMessage: Message = {
      role: 'user',
      contextKind: 'semantic_projection',
      content: JSON.stringify({ type: 'suncode.semantic_projection', projectionId: 'proj-1' }),
    };

    await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-compact:user-1',
      fact: {
        type: 'user_message_committed',
        source: 'dispatch',
        message: { role: 'user', content: 'first question' },
      },
    });
    await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-compact:user-2',
      fact: {
        type: 'user_message_committed',
        source: 'dispatch',
        message: { role: 'user', content: 'second question' },
      },
    });
    await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-compact:compaction:proj-1',
      fact: {
        type: 'compaction_applied',
        turnNumber: 3,
        mode: 'replace',
        projectionId: 'proj-1',
        sourceDigest: 'abc123',
        sourceStartIndex: 0,
        sourceEndIndex: 1,
        projectionMessage,
      },
    });
    await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-compact:assistant',
      fact: {
        type: 'assistant_message_committed',
        message: { role: 'assistant', content: 'final answer' },
      },
    });

    const events = await readRuntimeEvents(sessionId);

    // The compaction fact is durable and carries the full replacement detail.
    const compaction = events.find((event) => event.fact.type === 'compaction_applied');
    expect(compaction).toMatchObject({
      fact: {
        type: 'compaction_applied',
        projectionId: 'proj-1',
        sourceStartIndex: 0,
        sourceEndIndex: 1,
        projectionMessage,
      },
    });

    // Replaying the ledger reconstructs the exact message list: compaction
    // rewrites only the request view, never the durable messages.
    const messages = projectSessionRuntime(events).messages;
    expect(messages.map((message) => message.content)).toEqual([
      'first question',
      'second question',
      'final answer',
    ]);

    // Idempotent replay: re-appending the same eventId coalesces instead of duplicating.
    const duplicate = await appendRuntimeEvent(sessionId, {
      ...base,
      eventId: 'run-compact:compaction:proj-1',
      fact: {
        type: 'compaction_applied',
        turnNumber: 3,
        mode: 'replace',
        projectionId: 'proj-1',
        sourceDigest: 'abc123',
        sourceStartIndex: 0,
        sourceEndIndex: 1,
        projectionMessage,
      },
    });
    expect(duplicate.eventId).toBe('run-compact:compaction:proj-1');
    const afterDuplicate = await readRuntimeEvents(sessionId);
    expect(
      afterDuplicate.filter((event) => event.fact.type === 'compaction_applied'),
    ).toHaveLength(1);
  });
});
