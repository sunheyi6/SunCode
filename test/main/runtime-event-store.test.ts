import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { projectSessionRuntime } from '../../src/main/runtime-projector';
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
});
