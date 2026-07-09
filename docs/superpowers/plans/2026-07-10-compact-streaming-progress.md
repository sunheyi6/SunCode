# Compact Streaming Progress Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将执行中的助手输出展示为简短摘要与结构化工具/命令交替出现，并在执行结束后只显示最终回答。

**Architecture:** 保留现有 `ChatMessage.blocks` 和 `InlineCallTraceEntry` 顺序数据，不改变 IPC、消息持久化或工具协议。系统提示词要求模型把面向用户的过程文本写成最多五行的关键摘要；renderer 在流式阶段把 `text` block 放进过程时间线，隐藏重复的正文区域，结束后恢复最终正文展示。前端不截断、不改写摘要。

**Tech Stack:** Vue 3、TypeScript strict、Pinia stores、Vitest、Biome。

---

### Task 1: 增加进度摘要提示词

**Files:**
- Modify: `src/worker/agent/system-prompt.ts` in `getToolGuidelines`
- Test: `test/agent/system-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

在 `describe('buildSystemPrompt')` 中增加测试，验证普通工具调用提示包含以下行为约束：中间进度只展示关键逻辑摘要、摘要最多五行、摘要后继续调用具体工具或命令、不要输出完整思考过程。

```ts
  it('requires concise user-facing progress summaries before tools', () => {
    const prompt = parsePrompt();

    expect(prompt.guidelines).toContain(
      'For user-facing progress between tool calls, output only a concise key-logic summary of at most five lines, then use the concrete tool or command. Do not expose full internal reasoning.',
    );
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `bunx vitest run test/agent/system-prompt.test.ts -t "concise user-facing progress summaries"`

Expected: FAIL because `getToolGuidelines` does not yet include the exact progress instruction.

- [ ] **Step 3: Add the minimal prompt guideline**

在 `getToolGuidelines` 追加一条固定 guideline，放在通用的 `Be concise in your responses` 附近：

```ts
  result.push(
    'For user-facing progress between tool calls, output only a concise key-logic summary of at most five lines, then use the concrete tool or command. Do not expose full internal reasoning.',
  );
```

不要在 renderer 侧生成或截断摘要，也不要新增摘要模型调用。

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `bunx vitest run test/agent/system-prompt.test.ts -t "concise user-facing progress summaries"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/agent/system-prompt.test.ts src/worker/agent/system-prompt.ts
git commit -m "feat: guide concise streaming progress summaries"
```

### Task 2: 将流式文本摘要纳入过程时间线

**Files:**
- Modify: `src/renderer/components/chat/InlineCallTrace.vue` in the streaming template
- Modify: `src/renderer/components/chat/AssistantMessage.vue` in the streaming/main-content conditions
- Test: `test/renderer/call-trace-view-model.test.ts`

- [ ] **Step 1: Add a regression test for ordered summary entries**

在 `describe('buildInlineCallTrace')` 中增加一个中文流式案例，确认文本 block 和工具 block 按输入顺序保留，文本作为摘要候选而不是被过滤掉：

```ts
  test('keeps concise progress summaries beside tools in streaming order', () => {
    const message: ChatMessage = {
      id: 'a-progress-summary',
      role: 'assistant',
      content: '已定位启动入口',
      thinking: '',
      timestamp: 1,
      isStreaming: true,
      uiLanguage: 'zh',
      blocks: [
        { id: 'b1', type: 'text', text: '已定位启动入口' },
        {
          id: 'b2',
          type: 'tool_call',
          toolCall: { type: 'tool_call', id: 'tc1', name: 'grep', arguments: '{"pattern":"Git Panel"}' },
        },
      ],
      toolCalls: [
        {
          type: 'tool_call',
          id: 'tc1',
          name: 'grep',
          arguments: '{"pattern":"Git Panel"}',
          status: 'running',
        },
      ],
    };

    expect(buildInlineCallTrace(message).entries).toMatchObject([
      { kind: 'text', text: '已定位启动入口' },
      { kind: 'tools', isCurrent: true },
    ]);
  });
```

- [ ] **Step 2: Run the regression test and verify the current behavior**

Run: `bunx vitest run test/renderer/call-trace-view-model.test.ts -t "keeps concise progress summaries"`

Expected: PASS, proving the model already preserves the ordered text block; the missing behavior is only rendering.

- [ ] **Step 3: Render text blocks as streaming progress rows**

In the `isStreaming` branch of `InlineCallTrace.vue`, add a text branch before the tools branch:

```vue
      <div
        v-else-if="entry.kind === 'text'"
        class="streaming-process-text streaming-progress-summary"
        :class="{ active: entry.isActive }"
      >
        <StreamingText :text="entry.text" :is-streaming="entry.isActive" />
      </div>
```

Use the existing `StreamingText` renderer without changing its text. Add only local styling so summary rows use the same compact process typography and a subtle left accent; do not add line clamping, character limits, ellipses, or content rewriting.

- [ ] **Step 4: Hide the duplicate streaming final-content region**

In `AssistantMessage.vue`, change the main `.message-content` condition from `v-if="hasContent"` to render only after the message is complete:

```vue
        v-if="hasContent && !message.isStreaming"
```

The streaming text now appears through `InlineCallTrace`; once `message.isStreaming` becomes false, the complete `message.content` is rendered once in the main answer area. Keep the completed process details behavior unchanged.

- [ ] **Step 5: Run focused renderer tests**

Run: `bunx vitest run test/renderer/call-trace-view-model.test.ts test/renderer/chat-store.test.ts`

Expected: PASS, including existing tests for text/tool order, final text persistence, and tool progress.

- [ ] **Step 6: Commit**

```bash
git add test/renderer/call-trace-view-model.test.ts src/renderer/components/chat/InlineCallTrace.vue src/renderer/components/chat/AssistantMessage.vue
git commit -m "feat: show streaming summaries in the process timeline"
```

### Task 3: Full verification and visual smoke check

**Files:**
- No planned source changes; inspect the task files above and existing dirty-worktree files without staging unrelated changes.

- [ ] **Step 1: Run all focused tests together**

Run: `bunx vitest run test/agent/system-prompt.test.ts test/renderer/call-trace-view-model.test.ts test/renderer/chat-store.test.ts`

Expected: PASS with no failures.

- [ ] **Step 2: Run type checking**

Run: `bun run typecheck`

Expected: exit code 0.

- [ ] **Step 3: Run lint**

Run: `bun run lint`

Expected: exit code 0; pre-existing warnings may be reported, but no new errors should be introduced by these files.

- [ ] **Step 4: Perform the project visual check**

Run the required project command `bun run dev` in the background. Do not read log files for confirmation; use the visible Electron window as the readiness signal. Submit a representative task and confirm the UI sequence is:

```text
关键逻辑摘要
具体工具或命令
关键逻辑摘要
具体工具或命令
最终回答（只在过程结束后显示）
```

Confirm no full raw task narration is duplicated in the main answer while streaming, and confirm no frontend truncation marker is present.

- [ ] **Step 5: Review the final diff**

Run: `git diff HEAD~2..HEAD -- src/worker/agent/system-prompt.ts test/agent/system-prompt.test.ts src/renderer/components/chat/InlineCallTrace.vue src/renderer/components/chat/AssistantMessage.vue test/renderer/call-trace-view-model.test.ts`

Expected: only the prompt guideline, ordered streaming text rendering, completed-state deduplication, and focused regression tests are included; unrelated existing worktree changes remain untouched.

