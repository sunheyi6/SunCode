# Chat Input Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the chat composer as a theme-aware, rounded, integrated input surface matching the approved reference layout without changing its existing store or send behavior.

**Architecture:** Keep model, thinking, permission, and send orchestration inside `ChatInput.vue`. Extract only the textarea height calculation into a tiny renderer utility so multiline sizing can be covered by Bun tests before the Vue template is changed. Use scoped component styles and existing theme tokens; verify the final visual behavior in the running Electron renderer.

**Tech Stack:** Vue 3 Composition API, TypeScript, Pinia, scoped CSS, Bun test runner, Biome, Vite/Electron.

---

### Task 1: Add tested textarea sizing behavior

**Files:**
- Create: `src/renderer/components/chat/chat-input.ts`
- Create: `src/renderer/components/chat/chat-input.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from 'bun:test';
import { getComposerTextareaHeight } from './chat-input';

describe('getComposerTextareaHeight', () => {
  test('uses the minimum height for short input', () => {
    expect(getComposerTextareaHeight(32)).toBe(64);
  });

  test('uses the content height inside the supported range', () => {
    expect(getComposerTextareaHeight(112)).toBe(112);
  });

  test('caps tall input at the maximum height', () => {
    expect(getComposerTextareaHeight(280)).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test src/renderer/components/chat/chat-input.test.ts`

Expected: FAIL because `./chat-input` does not exist.

- [ ] **Step 3: Add the minimal sizing utility**

```ts
const MIN_TEXTAREA_HEIGHT = 64;
const MAX_TEXTAREA_HEIGHT = 200;

export function getComposerTextareaHeight(scrollHeight: number): number {
  return Math.min(Math.max(scrollHeight, MIN_TEXTAREA_HEIGHT), MAX_TEXTAREA_HEIGHT);
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `bun test src/renderer/components/chat/chat-input.test.ts`

Expected: 3 tests pass.

### Task 2: Rebuild the integrated composer

**Files:**
- Modify: `src/renderer/components/chat/ChatInput.vue`

- [ ] **Step 1: Wire textarea state and sizing**

Import `getComposerTextareaHeight`, add `hasInput`, and resize on `input`:

```ts
import { getComposerTextareaHeight } from './chat-input';

const hasInput = computed(() => inputText.value.trim().length > 0);

function resizeTextarea(): void {
  const textarea = textareaRef.value;
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${getComposerTextareaHeight(textarea.scrollHeight)}px`;
}
```

After send, set the textarea height to `64px`.

- [ ] **Step 2: Replace the template with the approved hierarchy**

Use this structure:

```vue
<div ref="inputRef" class="chat-input">
  <div class="composer" :class="{ streaming: isStreaming }">
    <textarea
      ref="textareaRef"
      v-model="inputText"
      class="input-field"
      placeholder="提出后续修改要求"
      rows="1"
      @input="resizeTextarea"
      @keydown="handleKeydown"
    />
    <div class="composer-toolbar">
      <div class="toolbar-group toolbar-left">
        <button class="icon-btn add-btn" type="button" aria-label="添加上下文">＋</button>
        <!-- permission dropdown -->
      </div>
      <div class="toolbar-group toolbar-right">
        <span class="status-indicator" aria-hidden="true" />
        <!-- model dropdown -->
        <!-- thinking dropdown -->
        <button
          class="send-btn"
          :class="{ queued: isStreaming }"
          type="button"
          :disabled="!hasInput"
          :aria-label="isStreaming ? '加入等待队列' : '发送消息'"
          @click="handleSend"
        >
          ↑
        </button>
      </div>
    </div>
  </div>
</div>
```

Preserve the existing dropdown loops and store calls, but replace malformed labels with:

```ts
const thinkingLevels = [
  { value: 'minimal' as const, label: '最小' },
  { value: 'low' as const, label: '低' },
  { value: 'medium' as const, label: '中' },
  { value: 'high' as const, label: '高' },
  { value: 'xhigh' as const, label: '最高' },
];
```

Use `完全访问`, `计划模式`, `自动编辑`, and `变更前确认` for permission labels.

- [ ] **Step 3: Replace scoped styles**

Implement:

- outer padding without a top divider;
- a `20px` rounded composer surface;
- borderless textarea with `64px` minimum and `200px` maximum height;
- left/right toolbar groups matching the reference;
- upward dropdown menus;
- neutral disabled send button, accent enabled button, purple queued button;
- `:focus-within` border and shadow;
- responsive truncation below `720px`.

- [ ] **Step 4: Run focused checks**

Run:

```powershell
bun test src/renderer/components/chat/chat-input.test.ts
bun run typecheck
bun run lint
```

Expected: all commands exit 0.

### Task 3: Verify the complete renderer behavior

**Files:**
- Verify: `src/renderer/components/chat/ChatInput.vue`
- Verify: `src/renderer/components/chat/chat-input.ts`

- [ ] **Step 1: Build the application**

Run: `bun run build`

Expected: Vite and Electron bundles complete with exit code 0.

- [ ] **Step 2: Perform browser/Electron visual verification**

Start with `bun run dev`, then verify:

- dark and light theme surfaces;
- empty input disables send;
- typing enables send;
- Enter sends and Shift+Enter creates a line break;
- multiline input grows from 64px and caps at 200px;
- model, thinking, and permission menus open upward and close outside;
- labels truncate without toolbar overflow in a narrow window;
- streaming state retains the queued send treatment.

- [ ] **Step 3: Review the final diff**

Run:

```powershell
git diff --check
git diff -- src/renderer/components/chat/ChatInput.vue src/renderer/components/chat/chat-input.ts src/renderer/components/chat/chat-input.test.ts
```

Expected: no whitespace errors and no unrelated file changes in the feature diff.
