# 顶部 Git 分支旁实时 Token 用量设计

## 目标

在右侧顶部窗口栏的 Git 分支控件右边显示当前运行的实时 token 消耗数量，沿用现有 agent 状态中的 token 统计，避免引入第二套计数口径。

## 现状

- `src/renderer/components/chat/ChatHeader.vue` 负责顶部窗口栏、会话信息和 Git 分支切换。
- `src/renderer/stores/agent.ts` 的 `status.tokenUsage` 接收 worker 状态事件中的实时 token 用量。
- `src/renderer/components/layout/StatusBar.vue` 已使用同一字段展示当前运行 token 总数。
- `src/shared/types.ts` 中 `TokenUsage.total` 是当前 agent 状态的累计总量。

## 方案

在 `ChatHeader.vue` 中直接使用 `useAgentStore()`，新增一个只读计算属性：当 `agentStore.status.tokenUsage.total > 0` 时，将数值格式化为带千分位的 `${total} tokens`；否则返回空字符串。模板把该文本放在 Git 分支下拉容器之后，作为非交互标签显示。

这样无需新增 IPC 或事件，worker 每次推送状态时 Pinia 响应式状态会自动刷新顶部文本；标签不包裹按钮，因此不改变 Git 分支菜单的交互和标题栏拖拽行为。

## 显示规则

- 有 token 消耗：显示如 `1,234 tokens`。
- 当前消耗为 0：隐藏标签。
- token 数字使用 `toLocaleString()` 格式化，遵循运行环境的千分位显示。
- 展示口径与底部 `StatusBar` 相同，使用 `status.tokenUsage.total`。

## 测试与验证

- 在现有 renderer 测试体系中覆盖 token 格式化函数：0 时为空字符串，正数时返回带千分位的 token 文案。
- 运行相关 Vitest 测试、`bun run typecheck` 和 `bun run lint`。
- 不修改现有未提交的 `ChatInput` 文件。

