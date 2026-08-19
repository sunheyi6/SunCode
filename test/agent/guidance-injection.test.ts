/**
 * Mid-run guidance injection — verifies the core contract:
 *  - 注入后下一轮 turn 在 contextMessages 末尾看到引导（model request 收到引导）
 *  - this.messages 同步增长（drainGuidance 把引导追加进历史）
 *  - 原 run 不 abort（loop 正常完成，不抛 AbortError）
 *  - 动态叠加：后注入的引导优先级更高（更靠近模型注意末端）
 *
 * Uses a streamImpl test seam to drive runAgentLoop without a real LLM.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { Agent } from '../../src/worker/agent/agent';
import { runAgentLoop } from '../../src/worker/agent/agent-loop';
import {
  appendRuntimeContextIfChanged,
  isUserAuthoredMessage,
} from '../../src/worker/agent/runtime-context';
import type { Tool } from '../../src/worker/tools/types';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { AppSettings, Message, RunEvent, StreamEvent } from '@shared/types';

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function mockTool(name: string): Tool {
  const definition = {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
  };
  return {
    ...definition,
    isReadonly: true,
    onProgress: null,
    getDefinition: () => definition,
    execute: () =>
      Promise.resolve({ toolCallId: '', name, success: true, output: `${name} result` }),
  };
}

/** A mock streamImpl that records the piContext.messages it received per call
 *  and yields the next canned text response, then a `done` event. */
function mockStream(responses: string[], captured: Array<{ messages: unknown[] }>) {
  let call = 0;
  return (
    _model: unknown,
    context: Record<string, unknown>,
  ): AsyncIterable<AssistantMessageEvent> => {
    const idx = call++;
    captured.push({ messages: (context.messages as unknown[]) ?? [] });
    const text = responses[idx] ?? responses[responses.length - 1] ?? 'ok';
    return (async function* () {
      yield { type: 'text_delta', contentIndex: 0, delta: text, partial: {} } as unknown as AssistantMessageEvent;
      yield {
        type: 'done',
        reason: 'stop',
        message: { stopReason: 'stop', usage: { input: 0, output: 0, totalTokens: 0 } },
      } as unknown as AssistantMessageEvent;
    })();
  };
}

function buildInput(overrides: Partial<Parameters<typeof runAgentLoop>[0]> & {
  messages: Message[];
  streamImpl: ReturnType<typeof mockStream>;
}) {
  const settings = { ...DEFAULT_SETTINGS } as AppSettings;
  return {
    model: {},
    tools: [],
    settings,
    workingDir: '',
    skillsContent: '',
    agentsMdContent: '',
    memoryContent: '',
    relevantLessonsContent: '',
    responseLanguage: 'zh' as const,
    abortSignal: new AbortController().signal,
    runId: 'test-run',
    sessionId: 'test-session',
    onStream: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onToolProgress: () => {},
    onRunEvent: () => {},
    initialTurnCount: 0,
    ...overrides,
  };
}

describe('runAgentLoop — mid-run guidance injection', () => {
  let tempDataDir: string;

  beforeEach(() => {
    // Keep DiagLogger from writing into the real app-data dir.
    tempDataDir = mkdtempSync(join(tmpdir(), 'suncode-guidance-'));
    process.env.SUNCODE_APP_DATA = tempDataDir;
  });

  it('forks semantic compact from the exact main prefix and consumes the accepted projection', async () => {
    const captured: Array<{
      messages: unknown[];
      systemPrompt?: unknown;
      tools?: unknown;
      options?: Record<string, unknown>;
    }> = [];
    const projection = JSON.stringify({
      objective: 'Complete the current task',
      constraints: ['Keep the head exact'],
      completedWork: ['Ran a tool'],
      currentState: ['Tool result is complete'],
      decisions: ['Continue from projection'],
      failedApproaches: [],
      unresolvedWork: ['Finish'],
      nextAction: 'Return the result',
    });
    let call = 0;
    const streamImpl = (
      _model: unknown,
      context: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): AsyncIterable<AssistantMessageEvent> => {
      const currentCall = call++;
      captured.push({
        messages: (context.messages as unknown[]) ?? [],
        systemPrompt: context.systemPrompt,
        tools: context.tools,
        options,
      });
      return (async function* () {
        if (currentCall === 0) {
          yield {
            type: 'toolcall_end',
            contentIndex: 0,
            toolCall: { type: 'toolCall', id: 'call-1', name: 'missing_tool', arguments: {} },
            partial: {},
          } as unknown as AssistantMessageEvent;
          yield {
            type: 'done',
            reason: 'toolUse',
            message: { stopReason: 'toolUse', usage: { input: 10, output: 2, totalTokens: 12 } },
          } as unknown as AssistantMessageEvent;
          return;
        }
        const text = currentCall === 1 ? projection : 'final answer';
        yield {
          type: 'text_delta',
          contentIndex: 0,
          delta: text,
          partial: {},
        } as unknown as AssistantMessageEvent;
        yield {
          type: 'done',
          reason: 'stop',
          message: { stopReason: 'stop', usage: { input: 10, output: 2, totalTokens: 12 } },
        } as unknown as AssistantMessageEvent;
      })();
    };
    const settings = {
      ...DEFAULT_SETTINGS,
      semanticCompactMode: 'replace' as const,
      semanticCompactThreshold: 0.000001,
      semanticCompactMinNewTokens: 1,
    } as AppSettings;

    await runAgentLoop(
      buildInput({
        messages: [userMsg('original task')],
        streamImpl,
        settings,
      }),
    );

    expect(captured).toHaveLength(3);
    const mainA = captured[0];
    const compactB = captured[1];
    const mainC = captured[2];
    expect(compactB.systemPrompt).toBe(mainA.systemPrompt);
    expect(compactB.tools).toEqual(mainA.tools);
    expect(compactB.options?.sessionId).toBe(mainA.options?.sessionId);
    expect(compactB.messages.slice(0, mainA.messages.length)).toEqual(mainA.messages);
    expect(JSON.stringify(compactB.messages.at(-1))).toContain(
      'suncode.semantic_compact_request',
    );
    expect(JSON.stringify(mainC.messages)).toContain('suncode.semantic_projection');
    expect(JSON.stringify(mainC.messages)).not.toContain('missing_tool');
  });

  it('keeps the request header stable and append-extends messages between ordinary steps', async () => {
    const captured: Array<{
      messages: unknown[];
      systemPrompt?: unknown;
      tools?: unknown;
    }> = [];
    const streamEvents: StreamEvent[] = [];
    let call = 0;
    const streamImpl = (
      _model: unknown,
      context: Record<string, unknown>,
    ): AsyncIterable<AssistantMessageEvent> => {
      const currentCall = call++;
      captured.push({
        messages: (context.messages as unknown[]) ?? [],
        systemPrompt: context.systemPrompt,
        tools: context.tools,
      });
      return (async function* () {
        if (currentCall === 0) {
          yield {
            type: 'toolcall_end',
            contentIndex: 0,
            toolCall: { type: 'toolCall', id: 'call-1', name: 'missing_tool', arguments: {} },
            partial: {},
          } as unknown as AssistantMessageEvent;
          yield {
            type: 'done',
            reason: 'toolUse',
            message: { stopReason: 'toolUse', usage: { input: 10, output: 2, totalTokens: 12 } },
          } as unknown as AssistantMessageEvent;
          return;
        }
        yield {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'final answer',
          partial: {},
        } as unknown as AssistantMessageEvent;
        yield {
          type: 'done',
          reason: 'stop',
          message: { stopReason: 'stop', usage: { input: 10, output: 2, totalTokens: 12 } },
        } as unknown as AssistantMessageEvent;
      })();
    };

    await runAgentLoop(
      buildInput({
        messages: [userMsg('inspect the request prefix')],
        streamImpl,
        tools: [mockTool('zeta'), mockTool('alpha')],
        onStream: (event) => streamEvents.push(event),
      }),
    );

    expect(captured).toHaveLength(2);
    const first = captured[0];
    const second = captured[1];
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.tools).toEqual(first.tools);
    expect((first.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(JSON.stringify(second.messages)).toContain('missing_tool');
    const parsedSystemPrompt = JSON.parse(String(first.systemPrompt));
    expect(parsedSystemPrompt.context).not.toHaveProperty('turnEvidence');
    expect(parsedSystemPrompt.context).not.toHaveProperty('memory');
    expect(parsedSystemPrompt.context).not.toHaveProperty('relevantLessons');
    expect(parsedSystemPrompt).not.toHaveProperty('responseLanguage');
    expect(parsedSystemPrompt.environment).not.toHaveProperty('currentDate');
    expect(JSON.stringify(first.messages[0])).toContain('suncode.runtime_context');
    expect(JSON.stringify(first.messages[1])).toContain('inspect the request prefix');
    expect(streamEvents.filter((event) => event.type === 'system_prompt')).toHaveLength(1);
  });

  it('only appends runtime context when its deterministic snapshot changes', () => {
    const messages = [userMsg('first')];
    const first = appendRuntimeContextIfChanged(messages, {
      memoryContent: 'remember this',
      responseLanguage: 'zh',
      currentDate: '2026-08-19',
    });
    expect(first).toBeDefined();
    expect(messages.map((message) => message.contextKind)).toEqual(['runtime_context', undefined]);
    expect(messages.filter(isUserAuthoredMessage)).toHaveLength(1);

    messages.push({ role: 'assistant', content: 'answer' }, userMsg('second'));
    expect(
      appendRuntimeContextIfChanged(messages, {
        memoryContent: 'remember this',
        responseLanguage: 'zh',
        currentDate: '2026-08-19',
      }),
    ).toBeUndefined();

    appendRuntimeContextIfChanged(messages, {
      memoryContent: 'updated memory',
      responseLanguage: 'zh',
      currentDate: '2026-08-19',
    });
    expect(messages.at(-2)?.contextKind).toBe('runtime_context');
    expect(messages.at(-1)?.content).toEqual(userMsg('second').content);
    expect(messages.filter(isUserAuthoredMessage)).toHaveLength(2);
  });

  it('injects private sub-agent runtime context without emitting it to the parent ledger', async () => {
    const captured: Array<{ messages: unknown[] }> = [];
    const events: RunEvent[] = [];
    await runAgentLoop(
      buildInput({
        messages: [userMsg('delegated task')],
        memoryContent: 'subagent memory',
        relevantLessonsContent: 'subagent lesson',
        responseLanguage: 'en',
        emitRuntimeContextEvent: false,
        streamImpl: mockStream(['done'], captured),
        onRunEvent: (event) => events.push(event),
      }),
    );

    const request = JSON.stringify(captured[0]?.messages);
    expect(request).toContain('subagent memory');
    expect(request).toContain('subagent lesson');
    expect(request).toContain('Respond in English');
    expect(events.some((event) => event.type === 'runtime_context_committed')).toBe(false);
  });

  it('preserves the completed tool chain as the exact prefix of the next run', async () => {
    const firstCaptured: Array<{ messages: unknown[] }> = [];
    let call = 0;
    const firstStream = (
      _model: unknown,
      context: Record<string, unknown>,
    ): AsyncIterable<AssistantMessageEvent> => {
      const currentCall = call++;
      firstCaptured.push({ messages: (context.messages as unknown[]) ?? [] });
      return (async function* () {
        if (currentCall === 0) {
          yield {
            type: 'toolcall_end',
            contentIndex: 0,
            toolCall: { type: 'toolCall', id: 'call-prefix', name: 'missing_tool', arguments: {} },
            partial: {},
          } as unknown as AssistantMessageEvent;
          yield {
            type: 'done',
            reason: 'toolUse',
            message: { stopReason: 'toolUse', usage: { input: 1, output: 1, totalTokens: 2 } },
          } as unknown as AssistantMessageEvent;
          return;
        }
        yield { type: 'text_delta', contentIndex: 0, delta: 'finished', partial: {} } as unknown as AssistantMessageEvent;
        yield {
          type: 'done',
          reason: 'stop',
          message: { stopReason: 'stop', usage: { input: 1, output: 1, totalTokens: 2 } },
        } as unknown as AssistantMessageEvent;
      })();
    };
    const first = await runAgentLoop(
      buildInput({ messages: [userMsg('first request')], streamImpl: firstStream }),
    );
    const nextMessages = [...first.modelMessages, userMsg('second request')];
    const secondCaptured: Array<{ messages: unknown[] }> = [];
    await runAgentLoop(
      buildInput({
        messages: nextMessages,
        runId: 'test-run-2',
        streamImpl: mockStream(['second answer'], secondCaptured),
      }),
    );

    const previousFinalRequest = firstCaptured.at(-1)!.messages;
    const nextRequest = secondCaptured[0]!.messages;
    expect(nextRequest.slice(0, previousFinalRequest.length)).toEqual(previousFinalRequest);
    expect(JSON.stringify(nextRequest)).toContain('finished');
    expect(JSON.stringify(nextRequest.at(-1))).toContain('second request');
  });

  afterEach(() => {
    delete process.env.SUNCODE_APP_DATA;
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('drains guidance queued before the run at turn 1, so the model sees it', async () => {
    const captured: Array<{ messages: unknown[] }> = [];
    const streamImpl = mockStream(['answer-1'], captured);

    // drainGuidance returns the guidance on the FIRST call (turn 1 top), then empty.
    let drainCalls = 0;
    const drainGuidance = () => {
      drainCalls += 1;
      return drainCalls === 1 ? [userMsg('guidance-A')] : [];
    };

    const result = await runAgentLoop(
      buildInput({
        messages: [userMsg('original')],
        streamImpl,
        drainGuidance,
      }),
    );

    // The model's turn-1 request context ends with the guidance user message.
    expect(captured.length).toBe(1);
    const turn1Msgs = captured[0].messages as Array<{ role?: string; content?: unknown }>;
    expect(turn1Msgs.length).toBe(3);
    expect(turn1Msgs.at(-1)?.role).toBe('user');
    expect(JSON.stringify(turn1Msgs.at(-1))).toContain('guidance-A');

    // The guidance was drained at turn-1 top; the stop-edge drain ran once
    // more (returning empty). Loop completed normally (not aborted).
    expect(drainCalls).toBe(2);
    expect(result.decision.decision).toBe('stop');
    expect(result.decision.reason).not.toBe('aborted');
  });

  it('drains guidance arriving during a would-be final turn and continues for another turn', async () => {
    const captured: Array<{ messages: unknown[] }> = [];
    const streamImpl = mockStream(['first-answer', 'after-guidance'], captured);

    // Simulate guidance injected DURING turn 1: turn-1-top drain returns [],
    // the stop-edge drain (call 2) returns the guidance, subsequent calls [].
    let drainCalls = 0;
    const drainGuidance = () => {
      drainCalls += 1;
      return drainCalls === 2 ? [userMsg('guidance-B')] : [];
    };

    const result = await runAgentLoop(
      buildInput({
        messages: [userMsg('original')],
        streamImpl,
        drainGuidance,
      }),
    );

    // Two turns ran: turn 1 (text stop → edge-drained guidance → continue), turn 2 (final).
    expect(captured.length).toBe(2);
    expect(drainCalls).toBeGreaterThanOrEqual(2);

    // Turn 1 request did NOT include the guidance (drained empty at turn-1 top).
    const turn1Msgs = captured[0].messages as Array<{ role?: string }>;
    expect(JSON.stringify(turn1Msgs)).not.toContain('guidance-B');

    // Turn 2 request includes the prior assistant answer AND the guidance
    // appended after it — so the model addresses the guidance next.
    const turn2Msgs = captured[1].messages as Array<{ role?: string; content?: unknown }>;
    const last = turn2Msgs[turn2Msgs.length - 1];
    expect(last?.role).toBe('user');
    expect(JSON.stringify(last)).toContain('guidance-B');
    // The assistant's turn-1 answer is retained (不篡改历史) before the guidance.
    const roles = turn2Msgs.map((m) => m.role);
    const lastAssistantIdx = roles.lastIndexOf('assistant');
    const lastUserIdx = roles.length - 1;
    expect(lastAssistantIdx).toBeGreaterThan(-1);
    expect(lastUserIdx).toBeGreaterThan(lastAssistantIdx);

    // Loop completed normally on turn 2 — no abort.
    expect(result.decision.decision).toBe('stop');
    expect(result.decision.reason).not.toBe('aborted');
    expect(result.finalMessage).toBeDefined();
  });

  it('emits guidance_injected stream + run events for each drained guidance', async () => {
    const streamEvents: StreamEvent[] = [];
    const runEvents: RunEvent[] = [];
    const streamImpl = mockStream(['answer'], []);

    let drainCalls = 0;
    const drainGuidance = () => {
      drainCalls += 1;
      return drainCalls === 1
        ? [userMsg('g-one'), userMsg('g-two')]
        : [];
    };

    await runAgentLoop(
      buildInput({
        messages: [userMsg('original')],
        streamImpl,
        drainGuidance,
        onStream: (e) => streamEvents.push(e),
        onRunEvent: (e) => runEvents.push(e),
      }),
    );

    const guidanceStream = streamEvents.filter((e) => e.type === 'guidance_injected');
    const guidanceRun = runEvents.filter((e) => e.type === 'guidance_injected');
    expect(guidanceStream).toHaveLength(2);
    expect(guidanceRun).toHaveLength(2);
    expect(guidanceStream.map((e) => e.text)).toEqual(['g-one', 'g-two']);
  });

  it('stacks multiple guidances in FIFO order (later = higher recency)', async () => {
    const captured: Array<{ messages: unknown[] }> = [];
    const streamImpl = mockStream(['answer'], captured);

    let drainCalls = 0;
    const drainGuidance = () => {
      drainCalls += 1;
      return drainCalls === 1 ? [userMsg('first-guidance'), userMsg('second-guidance')] : [];
    };

    await runAgentLoop(
      buildInput({
        messages: [userMsg('original')],
        streamImpl,
        drainGuidance,
      }),
    );

    const msgs = captured[0].messages as Array<{ role?: string; content?: unknown }>;
    // runtime context, original, first-guidance, second-guidance — later guidance is newest.
    expect(msgs.length).toBe(4);
    expect(JSON.stringify(msgs[2])).toContain('first-guidance');
    expect(JSON.stringify(msgs[3])).toContain('second-guidance');
  });
});

describe('Agent.injectGuidance / drainGuidance', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'suncode-agent-guid-'));
    // Isolate initialize() from the user's real ~/.suncode/agents.
    process.env.SUNCODE_APP_DATA = tempDir;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    delete process.env.SUNCODE_APP_DATA;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeAgent(): Agent {
    const noop = () => {};
    return new Agent(
      tempDir,
      { ...DEFAULT_SETTINGS } as AppSettings,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      'test-session',
    );
  }

  it('injectGuidance queues and drainGuidance appends to this.messages (no abort)', () => {
    const agent = makeAgent();
    agent.setMessages([userMsg('orig')]);

    // No abort controller exists when idle — injectGuidance must not create/abort one.
    agent.injectGuidance('g-one');
    agent.injectGuidance('g-two');

    const drained = agent.drainGuidance();
    expect(drained).toHaveLength(2);
    expect(drained.map((m) => (m.content as Array<{ text: string }>)[0]?.text)).toEqual([
      'g-one',
      'g-two',
    ]);

    // this.messages grew by exactly the two guidance user messages, in order.
    const messages = agent.getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe('user');
    expect(messages[2].role).toBe('user');

    // Second drain is a no-op (queue emptied) and leaves history intact.
    expect(agent.drainGuidance()).toEqual([]);
    expect(agent.getMessages()).toHaveLength(3);
  });

  it('drainGuidance emits no events by itself (the loop emits guidance_injected)', () => {
    const streamEvents: StreamEvent[] = [];
    const runEvents: RunEvent[] = [];
    const agent = new Agent(
      tempDir,
      { ...DEFAULT_SETTINGS } as AppSettings,
      (e) => streamEvents.push(e),
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      (e) => runEvents.push(e),
      () => {},
      () => {},
      'test-session',
    );
    agent.injectGuidance('silent-guidance');
    agent.drainGuidance();
    expect(streamEvents.filter((e) => e.type === 'guidance_injected')).toHaveLength(0);
    expect(runEvents.filter((e) => e.type === 'guidance_injected')).toHaveLength(0);
  });
});
