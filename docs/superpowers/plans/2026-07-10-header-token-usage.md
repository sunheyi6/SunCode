# 顶部 Git 分支旁实时 Token 用量 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在顶部窗口栏 Git 分支右侧显示当前 agent 运行的实时 token 总消耗。

**Architecture:** 复用 `useAgentStore().status.tokenUsage.total`，在 renderer 中通过纯函数完成显示格式化，再由 `ChatHeader.vue` 响应式渲染。无需新增 IPC、worker 事件或独立状态。

**Tech Stack:** Vue 3 `<script setup>`、Pinia、TypeScript、Vitest、Biome。

---

### Task 1: 添加 token 展示格式化的失败测试

**Files:**
- Create: `src/renderer/components/chat/header-token-usage.ts`
- Test: `src/renderer/components/chat/header-token-usage.test.ts`

- [ ] **Step 1: 写出纯函数契约测试**

测试 `formatHeaderTokenUsage(total)`：0 返回空字符串，正数返回带千分位的 `${total} tokens`。

```ts
import { describe, expect, it } from 'vitest';
import { formatHeaderTokenUsage } from './header-token-usage';

describe('formatHeaderTokenUsage', () => {
  it('hides the label when no tokens have been consumed', () => {
    expect(formatHeaderTokenUsage(0)).toBe('');
  });

  it('formats the current total with thousands separators', () => {
    expect(formatHeaderTokenUsage(1234)).toBe('1,234 tokens');
  });
});
```

- [ ] **Step 2: 运行测试确认先失败**

Run: `bunx vitest run src/renderer/components/chat/header-token-usage.test.ts`

Expected: FAIL，因为 `header-token-usage.ts` 尚未导出 `formatHeaderTokenUsage`。

### Task 2: 实现格式化函数并接入顶部窗口栏

**Files:**
- Modify: `src/renderer/components/chat/header-token-usage.ts`
- Modify: `src/renderer/components/chat/ChatHeader.vue`

- [ ] **Step 1: 写最小实现并让格式化测试通过**

```ts
export function formatHeaderTokenUsage(total: number): string {
  return total > 0 ? `${total.toLocaleString()} tokens` : '';
}
```

Run: `bunx vitest run src/renderer/components/chat/header-token-usage.test.ts`

Expected: 2 tests passed。

- [ ] **Step 2: 在 ChatHeader 使用现有 agent store**

在 `ChatHeader.vue` 引入 `formatHeaderTokenUsage` 和 `useAgentStore()`，新增：

```ts
const agentStore = useAgentStore();
const tokenUsageLabel = computed(() =>
  formatHeaderTokenUsage(agentStore.status.tokenUsage.total),
);
```

在 `.header-git-dropdown` 后追加非交互标签：

```vue
<span v-if="tokenUsageLabel" class="header-token-usage">
  {{ tokenUsageLabel }}
</span>
```

为标签增加与现有标题栏一致的紧凑、等宽字体样式，不包裹按钮、不改变 Git 分支菜单点击区域。

- [ ] **Step 3: 运行相关 renderer 测试**

Run: `bunx vitest run src/renderer/components/chat/header-token-usage.test.ts src/renderer/components/chat/chat-input.test.ts`

Expected: 新增测试及现有 ChatInput 测试全部通过。

### Task 3: 完整验证并检查改动边界

**Files:**
- Verify only: `src/renderer/components/chat/header-token-usage.ts`
- Verify only: `src/renderer/components/chat/header-token-usage.test.ts`
- Verify only: `src/renderer/components/chat/ChatHeader.vue`

- [ ] **Step 1: 运行完整测试**

Run: `bun run test`

Expected: Vitest 退出码为 0，所有测试通过。

- [ ] **Step 2: 运行类型检查**

Run: `bun run typecheck`

Expected: `tsc --noEmit` 退出码为 0。

- [ ] **Step 3: 运行 lint**

Run: `bun run lint`

Expected: 无 errors；若只有仓库既有 warnings，记录其数量，不修改无关文件。

- [ ] **Step 4: 检查 diff**

Run: `git diff -- src/renderer/components/chat/ChatHeader.vue src/renderer/components/chat/header-token-usage.ts src/renderer/components/chat/header-token-usage.test.ts`

Expected: 仅包含顶部 token 展示及其测试；保留用户现有 `ChatInput` 未提交修改。

