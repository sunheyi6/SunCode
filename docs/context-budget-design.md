# 上下文预算设计

日期: 2026-09-17 | 状态: 已实现

---

## 概述

上下文预算管理器（Context Budget Manager）是 agent loop 的**容量保护管线**：在每次模型迭代（turn）结束后、下一次 LLM 调用前，按**成本递增**的顺序对消息数组做三层治理。它解决的是"长任务必然撑爆上下文"的兜底问题。

**三层（按应用顺序，成本递增）：**

| 层 | 名称 | 性质 | 手段 |
|---|---|---|---|
| Layer 0 | Tool Result Prune | 无损 | 超大工具结果归档 + 占位符（可回读） |
| Layer 1 | Token Budget Turn Cap | 有损 | 按 token/轮次预算保留最近若干 turn |
| Layer 2 | History Compact | 有损 | 超过高水位时把旧 turn 折叠为摘要 |

**核心不变量：prune projection, never ledger. Archive before omission.**（裁剪的是送进模型请求的投影，不是持久化的消息账本；任何省略之前必须先归档。）

**核心原则：**

- **成本递增**：便宜且无损的先跑，昂贵且有损的后跑
- **无损优先**：Layer 0 先把内容完整落盘再替换为占位符
- **系统消息豁免**：`system` / `user` 消息永不被 Layer 1 丢弃
- **可诊断**：每次运行返回结构化 `ContextBudgetDiagnostic`，量化节省量与失败数

三层中 Layer 0 的完整协议见 [工具结果裁剪设计](tool-result-prune-design.md)；本层之外还有缓存友好的**主动语义压缩**，见 [上下文压缩设计](context-compaction-design.md)。三者是**不同职责域**，互不替代：

- Layer 0：管"单条巨物"（无损、按需恢复）
- Layer 1/2：管"整体历史"（有损、容量兜底）
- 语义压缩：复用主请求 prefix 的主动 projection（缓存友好、证据驱动）

---

## 处理时机

统一入口 `applyContextBudget`（`context-budget.ts`），由 `prepareNextTurn`（`agent-loop.ts`）在每个模型迭代完成后调用：

~~~typescript
export function applyContextBudget(
  messages: Message[],
  policy: ContextBudgetPolicy,
  options?: ContextBudgetOptions,
): { messages: Message[]; diagnostic: ContextBudgetDiagnostic }
~~~

总开关：`settings.autoCompact`（默认 true）。关闭后整条 pipeline 不运行。

---

## Layer 0：工具结果裁剪

`pruneToolResults` 对每条 `role === 'tool'` 消息依次过滤：

~~~
1. 已是占位符？                          → 跳过（isPlaceholderString）
2. recovery read（读回归档）？            → 跳过（防死循环）
3. token > maxResultTokens（默认 2048）？ → 归档 + 占位符（约 80 token）
4. 否则                                  → 保留原文
~~~

**每一个 turn、每一条工具结果都走同一条规则**——没有"最新轮 / 历史轮"之分，因此在每个 step 后统一判定即覆盖全部历史。归档失败时保留原始正文（fail-open），并把 `archiveFailures` 计入诊断。完整字段协议见 [工具结果裁剪设计](tool-result-prune-design.md)。

---

## Layer 1：Token 预算 Turn Cap

先把消息按 turn 分组（`groupMessagesByTurn`），再执行 `selectTurnsByBudget`：**从最新的 turn 往回保留**，直到触达预算。

~~~typescript
selectTurnsByBudget(groups, { maxTokens, maxHistoryTurns, minRecent })
~~~

规则：

- `system` 组无条件保留；
- 最近 `minRecent`（默认 2）个非 system turn **必须保留**（不受预算约束）；
- 超出 `minRecent` 后，命中 `maxTurns` 或 `maxTokens` 任一上限即停止保留；
- 过滤时 `system` / `user` 消息永远放行，只丢弃被选中的 turn 内的其余消息。

`maxTokens` / `maxTurns` 均为空时该层不生效。

---

## Layer 2：History Compact

**高水位触发、最后手段**：Layer 1 跑完后重新估算 token，若仍超过高水位则折叠旧 turn。

~~~typescript
const effectiveMax = maxTokens ?? 128_000;
const highWater = Math.floor(effectiveMax * (policy.historyCompact.highWaterRatio ?? 0.8));
if (afterLayer1Tokens > highWater) {
  const r = compactMessages(working, effectiveMax, policy.historyCompact.keepRecentTurns ?? 3);
  if (r.wasCompacted) { working = r.compactedMessages; compactedTurns = r.compactedCount; }
}
~~~

---

## 诊断

`applyContextBudget` 返回的 `ContextBudgetDiagnostic` 描述了本层做了什么、省了多少：

| 字段 | 含义 |
|---|---|
| `changed` | 消息数变化或发生了裁剪/归档失败 |
| `beforeTokens` / `afterTokens` | 处理前后估算 token |
| `beforeMessages` / `afterMessages` | 处理前后消息条数 |
| `prunedToolResults` / `estimatedTokensSaved` | Layer 0 裁剪条数与节省量（>0 时出现） |
| `archiveFailures` | 归档失败次数（>0 时出现） |
| `droppedTurns` | Layer 1 丢弃的 turn 数（>0 时出现） |
| `compactedTurns` | Layer 2 折叠的 turn 数（>0 时出现） |

**可选字段用条件展开**（`...(x > 0 ? { k: x } : {})`），保证 0 值时不出现在诊断里。

---

## 关键约束

1. **不变量** — prune projection, never ledger；archive before omission
2. **成本顺序** — Layer 0 → 1 → 2，不得倒置
3. **system/user 豁免** — Layer 1 过滤只丢 turn 内非 system/user 消息
4. **minRecent 保底** — 最近 2 个 turn 不受预算约束
5. **高水位默认 0.8** — `effectiveMax` 缺省 128K；`keepRecentTurns` 缺省 3
6. **占位符约 80 token** — 节省量 = `max(0, originalTokens - 80)`

---

## 相关源码

| 模块 | 路径 |
|---|---|
| 管线入口 | `src/worker/agent/context-budget.ts`（`applyContextBudget`） |
| Layer 0 裁剪 | `src/worker/agent/context-budget.ts`（`pruneToolResults` / `buildPlaceholder`） |
| Layer 1 分组与选择 | `src/worker/agent/context-budget.ts`（`groupMessagesByTurn` / `selectTurnsByBudget`） |
| Layer 2 折叠 | `src/worker/agent/compaction.ts`（`compactMessages`） |
| 归档 | `src/worker/agent/tool-result-archive.ts` |
| token 估算 | `src/worker/utils/token-counter.ts` |
| 触发点 | `src/worker/agent/agent-loop.ts` / `src/worker/agent/agent.ts`（`prepareNextTurn`） |
| 策略/诊断类型 | `src/shared/types.ts` |
| 测试 | `test/agent/context-budget.test.ts` |
