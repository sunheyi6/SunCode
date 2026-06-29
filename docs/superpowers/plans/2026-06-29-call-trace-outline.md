# Call Trace Outline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an outline-first call trace panel that shows the complete agent flow with useful collapsed summaries.

**Architecture:** Move trace shaping into a renderer utility, then render grouped outline sections in `CallTracePanel.vue`. Keep worker events and persisted message formats unchanged; reuse existing tool operation cards for detail views.

**Tech Stack:** Vue 3, Pinia store message types, Vitest, TypeScript strict mode.

---

## File Structure

- Create `src/renderer/components/chat/call-trace-view-model.ts`: pure functions and types for turning `ChatMessage[]` plus system prompt into outline groups.
- Create `test/renderer/call-trace-view-model.test.ts`: behavior tests for grouping, summaries, tool matching, and legacy fallback.
- Modify `src/renderer/components/chat/CallTracePanel.vue`: import the view model and render outline-first groups with details collapsed by default.
- Optionally modify `src/renderer/components/chat/AssistantMessage.vue`: keep only minimal cleanup if needed for compact progress text; do not redesign chat in the same pass.

### Task 1: Extract Trace View Model

**Files:**
- Create: `src/renderer/components/chat/call-trace-view-model.ts`
- Test: `test/renderer/call-trace-view-model.test.ts`

- [ ] **Step 1: Write the failing grouping test**

Add this test to `test/renderer/call-trace-view-model.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import type { ChatMessage } from '../../src/renderer/stores/chat';
import { buildCallTraceOutline } from '../../src/renderer/components/chat/call-trace-view-model';

describe('buildCallTraceOutline', () => {
  test('groups user requests and assistant model turns into an outline', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: '检查当前实现',
        timestamp: 10,
        isStreaming: false,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: '完成',
        timestamp: 20,
        isStreaming: false,
        turnDetails: [
          {
            turnNumber: 1,
            systemTokens: 100,
            requestMessages: [{ role: 'user', length: 6, preview: '检查当前实现' }],
            response: {
              text: '',
              thinking: '需要先读取文件',
              toolCalls: [
                { type: 'tool_call', id: 'tc1', name: 'read', arguments: '{"file_path":"src/a.ts"}' },
              ],
              inputTokens: 120,
              outputTokens: 30,
              durationMs: 1500,
              stopReason: 'tool_calls',
            },
          },
          {
            turnNumber: 2,
            systemTokens: 100,
            requestMessages: [{ role: 'tool', length: 12, preview: 'file content' }],
            response: {
              text: '完成',
              thinking: '',
              toolCalls: [],
              inputTokens: 140,
              outputTokens: 20,
              durationMs: 800,
              stopReason: 'stop',
            },
          },
        ],
        toolCalls: [
          {
            type: 'tool_call',
            id: 'tc1',
            name: 'read',
            arguments: '{"file_path":"src/a.ts"}',
            status: 'done',
            result: { toolCallId: 'tc1', name: 'read', success: true, output: 'file content' },
          },
        ],
      },
    ];

    const outline = buildCallTraceOutline({ messages, systemPrompt: 'system prompt' });

    expect(outline.systemPrompt?.charCount).toBe(13);
    expect(outline.entries).toHaveLength(3);
    expect(outline.entries[0]).toMatchObject({ kind: 'user', content: '检查当前实现' });
    expect(outline.entries[1]).toMatchObject({
      kind: 'turn',
      turnNumber: 1,
      summary: expect.objectContaining({
        toolCount: 1,
        completedToolCount: 1,
        failedToolCount: 0,
        inputTokens: 120,
        outputTokens: 30,
      }),
      sections: expect.arrayContaining([
        expect.objectContaining({ kind: 'input', itemCount: 1, defaultOpen: false }),
        expect.objectContaining({ kind: 'thinking', charCount: 7, defaultOpen: false }),
        expect.objectContaining({ kind: 'tools', itemCount: 1, defaultOpen: false }),
      ]),
    });
    expect(outline.entries[2]).toMatchObject({
      kind: 'turn',
      turnNumber: 2,
      sections: expect.arrayContaining([
        expect.objectContaining({ kind: 'response', charCount: 2, defaultOpen: false }),
      ]),
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/renderer/call-trace-view-model.test.ts`

Expected: FAIL because `call-trace-view-model.ts` does not exist.

- [ ] **Step 3: Implement the minimal view model**

Create `src/renderer/components/chat/call-trace-view-model.ts`:

```ts
import type { ToolCallContent, TurnDetail } from '@shared/types';
import type { ChatMessage } from '../../stores/chat';

export interface CallTraceOutline {
  systemPrompt?: { text: string; charCount: number };
  entries: CallTraceEntry[];
}

export type CallTraceEntry =
  | { kind: 'user'; id: string; content: string; timestamp: number }
  | CallTraceTurnEntry;

export interface CallTraceTurnEntry {
  kind: 'turn';
  id: string;
  turnNumber: number;
  modelLabel: string;
  isStreaming: boolean;
  summary: CallTraceTurnSummary;
  sections: CallTraceSection[];
}

export interface CallTraceTurnSummary {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  toolCount: number;
  completedToolCount: number;
  failedToolCount: number;
}

export type CallTraceSection =
  | {
      kind: 'input';
      title: string;
      itemCount: number;
      systemTokens: number;
      requestMessages: Array<{ role: string; length: number; preview: string }>;
      defaultOpen: boolean;
    }
  | { kind: 'thinking'; title: string; text: string; charCount: number; defaultOpen: boolean }
  | { kind: 'tools'; title: string; toolCalls: ToolCallContent[]; itemCount: number; defaultOpen: boolean }
  | { kind: 'response'; title: string; text: string; charCount: number; defaultOpen: boolean };

export function buildCallTraceOutline(input: {
  messages: ChatMessage[];
  systemPrompt: string;
}): CallTraceOutline {
  const entries: CallTraceEntry[] = [];

  for (const msg of input.messages) {
    if (msg.role === 'user') {
      entries.push({
        kind: 'user',
        id: msg.id,
        content: msg.content,
        timestamp: msg.timestamp,
      });
      continue;
    }

    if (msg.role !== 'assistant') continue;

    const turns = getTurns(msg);
    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index]!;
      entries.push(buildTurnEntry(msg, turn, index));
    }
  }

  return {
    systemPrompt: input.systemPrompt
      ? { text: input.systemPrompt, charCount: input.systemPrompt.length }
      : undefined,
    entries,
  };
}

function buildTurnEntry(msg: ChatMessage, turn: TurnDetail, index: number): CallTraceTurnEntry {
  const executedToolCalls = matchExecutedToolCalls(turn.response.toolCalls, msg.toolCalls ?? []);
  const raw = turn as Record<string, unknown>;
  const provider = typeof raw.provider === 'string' ? raw.provider : '';
  const model = typeof raw.model === 'string' ? raw.model : '';
  const toolCount = executedToolCalls.length;
  const failedToolCount = executedToolCalls.filter(
    (toolCall) => toolCall.status === 'error' || toolCall.result?.success === false,
  ).length;
  const completedToolCount = executedToolCalls.filter(
    (toolCall) => toolCall.status === 'done' || toolCall.result,
  ).length;

  return {
    kind: 'turn',
    id: `${msg.id}:turn:${turn.turnNumber}:${index}`,
    turnNumber: turn.turnNumber,
    modelLabel: provider && model ? `${provider}/${model}` : '',
    isStreaming: Boolean(msg.isStreaming && index === getTurns(msg).length - 1),
    summary: {
      durationMs: turn.response.durationMs,
      inputTokens: turn.response.inputTokens,
      outputTokens: turn.response.outputTokens,
      stopReason: turn.response.stopReason,
      toolCount,
      completedToolCount,
      failedToolCount,
    },
    sections: buildSections(turn, executedToolCalls),
  };
}

function buildSections(turn: TurnDetail, toolCalls: ToolCallContent[]): CallTraceSection[] {
  const sections: CallTraceSection[] = [
    {
      kind: 'input',
      title: `输入 · ${turn.requestMessages.length} 条消息`,
      itemCount: turn.requestMessages.length,
      systemTokens: turn.systemTokens,
      requestMessages: turn.requestMessages,
      defaultOpen: false,
    },
  ];

  if (turn.response.thinking) {
    sections.push({
      kind: 'thinking',
      title: `思考 · ${turn.response.thinking.length} 字符`,
      text: turn.response.thinking,
      charCount: turn.response.thinking.length,
      defaultOpen: false,
    });
  }

  if (toolCalls.length > 0) {
    sections.push({
      kind: 'tools',
      title: `工具 · ${toolCalls.length} 个`,
      toolCalls,
      itemCount: toolCalls.length,
      defaultOpen: false,
    });
  }

  if (turn.response.text) {
    sections.push({
      kind: 'response',
      title: `回复 · ${turn.response.text.length} 字符`,
      text: turn.response.text,
      charCount: turn.response.text.length,
      defaultOpen: false,
    });
  }

  return sections;
}

function getTurns(msg: ChatMessage): TurnDetail[] {
  if (msg.turnDetails && msg.turnDetails.length > 0) return msg.turnDetails;
  if (msg.thinking || msg.content || (msg.toolCalls && msg.toolCalls.length > 0)) {
    return [
      {
        turnNumber: msg.turnCount ?? 1,
        systemTokens: 0,
        requestMessages: [{ role: 'user', length: msg.content.length, preview: msg.content.slice(0, 200) }],
        response: {
          text: msg.content,
          thinking: msg.thinking || '',
          toolCalls: msg.toolCalls ?? [],
        },
      },
    ];
  }
  return [];
}

function matchExecutedToolCalls(
  modelToolCalls: ToolCallContent[],
  executedToolCalls: ToolCallContent[],
): ToolCallContent[] {
  return modelToolCalls.map((modelToolCall) => {
    return executedToolCalls.find((toolCall) => toolCall.id === modelToolCall.id) ?? modelToolCall;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/renderer/call-trace-view-model.test.ts`

Expected: PASS.

### Task 2: Cover Legacy and Running State

**Files:**
- Modify: `test/renderer/call-trace-view-model.test.ts`
- Modify: `src/renderer/components/chat/call-trace-view-model.ts`

- [ ] **Step 1: Add failing tests for legacy fallback and active tool state**

Append these tests inside the existing `describe` block:

```ts
  test('builds a legacy turn when an assistant message has no turn details', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a-legacy',
        role: 'assistant',
        content: '旧消息回复',
        thinking: '旧思考',
        timestamp: 1,
        isStreaming: false,
        toolCalls: [
          { type: 'tool_call', id: 'tc-old', name: 'grep', arguments: '{"pattern":"trace"}', status: 'done' },
        ],
      },
    ];

    const outline = buildCallTraceOutline({ messages, systemPrompt: '' });

    expect(outline.entries).toHaveLength(1);
    expect(outline.entries[0]).toMatchObject({
      kind: 'turn',
      turnNumber: 1,
      summary: expect.objectContaining({ toolCount: 1 }),
      sections: expect.arrayContaining([
        expect.objectContaining({ kind: 'thinking', charCount: 3 }),
        expect.objectContaining({ kind: 'tools', itemCount: 1 }),
        expect.objectContaining({ kind: 'response', charCount: 5 }),
      ]),
    });
  });

  test('marks the latest streaming turn and keeps its running tool section open', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a-running',
        role: 'assistant',
        content: '',
        timestamp: 1,
        isStreaming: true,
        turnDetails: [
          {
            turnNumber: 1,
            systemTokens: 50,
            requestMessages: [],
            response: {
              text: '',
              thinking: '',
              toolCalls: [
                { type: 'tool_call', id: 'tc-run', name: 'bash', arguments: '{"command":"npm test"}' },
              ],
            },
          },
        ],
        toolCalls: [
          { type: 'tool_call', id: 'tc-run', name: 'bash', arguments: '{"command":"npm test"}', status: 'running' },
        ],
      },
    ];

    const outline = buildCallTraceOutline({ messages, systemPrompt: '' });
    const turn = outline.entries[0];

    expect(turn).toMatchObject({
      kind: 'turn',
      isStreaming: true,
      summary: expect.objectContaining({ completedToolCount: 0, failedToolCount: 0 }),
    });
    expect(turn.kind === 'turn' ? turn.sections : []).toContainEqual(
      expect.objectContaining({ kind: 'tools', defaultOpen: true }),
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/renderer/call-trace-view-model.test.ts`

Expected: FAIL because the tool section does not yet open for a running tool.

- [ ] **Step 3: Update section defaults for running tools**

In `buildSections`, change the tools section to set `defaultOpen` from tool state:

```ts
  if (toolCalls.length > 0) {
    const hasRunningTool = toolCalls.some((toolCall) => toolCall.status === 'running');
    sections.push({
      kind: 'tools',
      title: `工具 · ${toolCalls.length} 个`,
      toolCalls,
      itemCount: toolCalls.length,
      defaultOpen: hasRunningTool,
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/renderer/call-trace-view-model.test.ts`

Expected: PASS.

### Task 3: Render Outline in CallTracePanel

**Files:**
- Modify: `src/renderer/components/chat/CallTracePanel.vue`
- Test: `test/renderer/call-trace-view-model.test.ts`

- [ ] **Step 1: Add a failing summary behavior test**

Append this test inside the existing `describe` block:

```ts
  test('summarizes mixed successful and failed tools for collapsed rows', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a-tools',
        role: 'assistant',
        content: '',
        timestamp: 1,
        isStreaming: false,
        turnDetails: [
          {
            turnNumber: 1,
            systemTokens: 1,
            requestMessages: [],
            response: {
              text: '',
              thinking: '',
              toolCalls: [
                { type: 'tool_call', id: 'ok', name: 'read', arguments: '{}' },
                { type: 'tool_call', id: 'bad', name: 'bash', arguments: '{}' },
              ],
            },
          },
        ],
        toolCalls: [
          { type: 'tool_call', id: 'ok', name: 'read', arguments: '{}', status: 'done', result: { toolCallId: 'ok', name: 'read', success: true, output: '' } },
          { type: 'tool_call', id: 'bad', name: 'bash', arguments: '{}', status: 'error', result: { toolCallId: 'bad', name: 'bash', success: false, output: '', error: 'failed' } },
        ],
      },
    ];

    const outline = buildCallTraceOutline({ messages, systemPrompt: '' });

    expect(outline.entries[0]).toMatchObject({
      kind: 'turn',
      summary: expect.objectContaining({
        toolCount: 2,
        completedToolCount: 2,
        failedToolCount: 1,
      }),
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails if completed failed tools are not counted**

Run: `npm test -- test/renderer/call-trace-view-model.test.ts`

Expected: PASS if Task 1 already counts result-bearing failed tools as completed; otherwise FAIL and fix the summary calculation by counting any `result` as completed.

- [ ] **Step 3: Replace panel timeline construction with outline construction**

In `CallTracePanel.vue`, remove the local `TimelineEntry`, `timeline`, `getTurns`, and `legacyTurnDetail` definitions. Import and use:

```ts
import type { CallTraceSection, CallTraceTurnEntry } from './call-trace-view-model';
import { buildCallTraceOutline } from './call-trace-view-model';
```

Add:

```ts
const outline = computed(() =>
  buildCallTraceOutline({
    messages: props.messages,
    systemPrompt: props.systemPrompt,
  }),
);
```

Update the system prompt computed to use `outline.value.systemPrompt?.text ?? ''`.

- [ ] **Step 4: Render entries as outline rows**

Replace the timeline template with:

```vue
      <div v-if="outline.entries.length === 0" class="trace-empty">
        暂无调用记录
      </div>

      <template v-for="entry in outline.entries" :key="entry.kind === 'user' ? entry.id : entry.id">
        <details v-if="entry.kind === 'user'" class="outline-row outline-user">
          <summary class="outline-summary">
            <span class="outline-caret">›</span>
            <span class="outline-title">用户请求</span>
            <span class="outline-preview">{{ entry.content }}</span>
            <span class="outline-meta">{{ formatTime(entry.timestamp) }}</span>
          </summary>
          <div class="outline-body">
            <p class="outline-user-content">{{ entry.content }}</p>
          </div>
        </details>

        <details
          v-else
          class="outline-row outline-turn"
          :class="{ 'outline-running': entry.isStreaming, 'outline-failed': entry.summary.failedToolCount > 0 }"
          :open="entry.isStreaming"
        >
          <summary class="outline-summary">
            <span class="outline-caret">›</span>
            <span class="outline-title">第 {{ entry.turnNumber }} 轮模型调用</span>
            <span v-if="entry.modelLabel" class="outline-chip">{{ entry.modelLabel }}</span>
            <span class="outline-meta">{{ turnSummary(entry) }}</span>
          </summary>
          <div class="outline-body">
            <template v-for="section in entry.sections" :key="`${entry.id}:${section.kind}`">
              <details class="outline-section" :open="section.defaultOpen">
                <summary class="outline-section-summary">
                  <span class="outline-caret">›</span>
                  <span>{{ section.title }}</span>
                  <span class="outline-section-meta">{{ sectionMeta(section) }}</span>
                </summary>
                <div class="outline-section-body">
                  <template v-if="section.kind === 'input'">
                    <div v-for="(rm, ri) in section.requestMessages" :key="ri" class="tl-req-msg">
                      <div class="tl-req-role">{{ rm.role.toUpperCase() }} · {{ rm.length }} 字符</div>
                      <pre class="tl-req-preview">{{ rm.preview }}</pre>
                    </div>
                  </template>
                  <StreamingText v-else-if="section.kind === 'thinking'" :text="section.text" :is-streaming="false" />
                  <template v-else-if="section.kind === 'tools'">
                    <div v-for="tc in section.toolCalls" :key="tc.id" class="tl-tool-item">
                      <SubagentCard v-if="tc.name === 'subagent'" :call="tc" />
                      <FileOperationCard v-else-if="tc.name === 'edit' || tc.name === 'write'" :call="tc" />
                      <CommandOperationCard v-else-if="tc.name === 'bash'" :call="tc" />
                      <FileInspectCard v-else-if="tc.name === 'read' || tc.name === 'glob' || tc.name === 'grep'" :call="tc" />
                      <details v-else class="tl-generic-tool">
                        <summary class="tl-generic-summary">
                          <span class="tl-generic-name">{{ tc.name }}</span>
                          <span class="tl-generic-summary-text">{{ toolSummary(tc) }}</span>
                        </summary>
                        <pre><code>{{ tc.arguments }}</code></pre>
                      </details>
                    </div>
                  </template>
                  <StreamingText v-else-if="section.kind === 'response'" :text="section.text" :is-streaming="entry.isStreaming" />
                </div>
              </details>
            </template>
          </div>
        </details>
      </template>
```

- [ ] **Step 5: Add helper functions for row summaries**

Add these functions to the script:

```ts
function turnSummary(entry: CallTraceTurnEntry): string {
  const parts: string[] = [];
  if (entry.summary.durationMs !== undefined) parts.push(formatDuration(entry.summary.durationMs));
  parts.push(`in ${formatTokens(entry.summary.inputTokens)}`);
  parts.push(`out ${formatTokens(entry.summary.outputTokens)}`);
  if (entry.summary.toolCount > 0) {
    const failed = entry.summary.failedToolCount > 0 ? `，失败 ${entry.summary.failedToolCount}` : '';
    parts.push(`工具 ${entry.summary.completedToolCount}/${entry.summary.toolCount}${failed}`);
  }
  if (entry.summary.stopReason) parts.push(entry.summary.stopReason);
  if (entry.isStreaming) parts.push('进行中');
  return parts.join(' · ');
}

function sectionMeta(section: CallTraceSection): string {
  if (section.kind === 'input') return `system ${formatTokens(section.systemTokens)}`;
  if (section.kind === 'tools') return `${section.itemCount} 个`;
  return `${section.charCount} 字符`;
}
```

- [ ] **Step 6: Update panel CSS for outline hierarchy**

Add CSS classes for `.outline-row`, `.outline-summary`, `.outline-body`, `.outline-section`, `.outline-section-summary`, `.outline-section-body`, `.outline-running`, `.outline-failed`, `.outline-chip`, `.outline-preview`, and `.outline-meta`. Reuse existing colors and spacing variables. Keep cards radius at `var(--border-radius-sm)`.

- [ ] **Step 7: Run tests**

Run: `npm test -- test/renderer/call-trace-view-model.test.ts`

Expected: PASS.

### Task 4: Verification

**Files:**
- Modify only files touched in earlier tasks.

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 2: Run renderer/view-model tests**

Run: `npm test -- test/renderer/call-trace-view-model.test.ts`

Expected: PASS.

- [ ] **Step 3: Run lint on changed source**

Run: `npm run lint`

Expected: PASS or only pre-existing unrelated lint failures. If lint fails in changed files, fix those failures.

- [ ] **Step 4: Start the desktop app**

Run in background: `npm run dev`

Expected: Electron window opens on fixed port `5173`. Do not read log files after startup.

## Self-Review

- Spec coverage: The plan covers outline grouping, collapsed defaults, summary rows, tool card reuse, renderer-only architecture, and behavior tests.
- Placeholder scan: No `TBD`, `TODO`, or unspecified implementation steps remain.
- Type consistency: `CallTraceOutline`, `CallTraceEntry`, `CallTraceTurnEntry`, and `CallTraceSection` are introduced in Task 1 and reused consistently in later tasks.
