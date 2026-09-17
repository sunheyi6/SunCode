# 简单任务进度护栏设计

日期: 2026-09-17 | 状态: 已实现

---

## 概述

进度护栏（Progress Guard）防止**表面级小改动任务**陷入"无限调查"：模型反复 read/grep、迟迟不和文件系统发生一次成功写入，直到把轮次预算烧光。

它只对分类器判定为"简单任务"的 prompt 启用，通过**主动注入提醒**并在必要时**收紧轮次上限**，把任务逼回"动手修改"这条路径。

**核心原则：**

- **只对小改动启用**：分类器保守，宁可漏判也不误伤复杂任务
- **成功写入即解除**：只要发生一次成功的 `edit` / `write`，护栏立即结束
- **提醒优先、收紧兜底**：先注入 guidance，仍未动笔才收紧 `loopTurnLimit`
- **失败也算调查**：失败尝试与委派探索同样计入调查轮次

---

## 启用条件

护栏由 `isSimpleTask`（`task-policy.ts`）门控，与 `applyOrdinaryTaskPolicy` 同源：

~~~typescript
export function isSimpleTask(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized || normalized.length > 240) return false;
  if (COMPLEX_TASK_SIGNALS.test(normalized)) return false;
  return SIMPLE_TASK_SIGNALS.test(normalized);
}
~~~

| 判据 | 内容 |
|---|---|
| 长度 | ≤ 240 字符（过长一律不算简单） |
| 复杂信号（否决） | 架构 / 并发 / 竞态 / 死锁 / 崩溃 / 性能 / 安全 / 迁移 / 重构 / 内存泄漏 / 数据丢失 / 根因分析 / 发布 / 部署 … |
| 简单信号（必要条件） | 颜色 / 文案 / 间距 / 按钮 / 图标 / 样式 / 标题 / 对齐 / 重命名 / 替换 … |

命中简单任务时，`applyOrdinaryTaskPolicy` 同步把任务策略收紧：

- `maxTurns` → `min(settings.maxTurns, SIMPLE_TASK_MAX_TURNS = 30)`
- `thinkingLevel`：`xhigh` → `medium`

---

## 状态机

~~~typescript
export interface ProgressGuardState {
  investigationTurns: number;   // 连续无成功写入的轮数
  materialChangeMade: boolean;  // 是否已发生成功 edit/write
  warned: boolean;              // 8 轮提醒是否已发出
  hardLimitApplied: boolean;    // 12 轮硬限是否已生效
}
~~~

`updateSimpleTaskProgressGuard(state, toolCalls, toolResults)` 每轮返回 `{ state, guidance?, forceFinishWithinTurns? }`：

| 输入 | 状态转移 | 输出 |
|---|---|---|
| 已 `materialChangeMade` 或本轮无工具调用 | 不变 | `{ state }` |
| 本轮有成功的 `edit` / `write` | `materialChangeMade = true`，`investigationTurns = 0` | `{ state }`（护栏解除） |
| 其余情况 | `investigationTurns += 1` | 见下 |

**三个常量：**

| 常量 | 值 | 含义 |
|---|---|---|
| `SIMPLE_TASK_PROGRESS_WARNING_TURNS` | 8 | 触发首次提醒 |
| `SIMPLE_TASK_PROGRESS_HARD_TURNS` | 12 | 触发硬约束 + 收紧轮次 |
| `SIMPLE_TASK_FORCED_FINISH_TURNS` | 2 | 硬约束后仅允许的剩余轮数 |

**两次动作（各只触发一次，由 `warned` / `hardLimitApplied` 守卫）：**

- `investigationTurns >= 8`：注入提醒 guidance（已连续多轮只在调查，请收敛到当前最可信的根因）
- `investigationTurns >= 12`：注入硬约束 guidance（停止扩大搜索范围；若证据不足请直接说明阻塞），并返回 `forceFinishWithinTurns = 2`

---

## 接线（agent-loop.ts）

~~~typescript
const guardSimpleTask = isSimpleTask(latestUserPrompt);
let progressGuardState = createProgressGuardState();
// …每个含工具调用的 turn 结束后：
if (guardSimpleTask) {
  const materialChangeWasMade = progressGuardState.materialChangeMade;
  const guardUpdate = updateSimpleTaskProgressGuard(progressGuardState, toolCalls, toolResults);
  progressGuardState = guardUpdate.state;
  // 首次成功写入 → 放宽上限，给"验证 + 收尾"留出空间
  if (!materialChangeWasMade && progressGuardState.materialChangeMade) {
    loopTurnLimit = Math.max(loopTurnLimit, Math.min(configuredLoopTurnLimit, turnCount + 3));
  }
  if (guardUpdate.guidance) {
    // user 消息注入 + guidance_injected 流事件 + run event + diag milestone
  }
  if (guardUpdate.forceFinishWithinTurns !== undefined) {
    loopTurnLimit = Math.min(loopTurnLimit, turnCount + guardUpdate.forceFinishWithinTurns);
  }
}
~~~

要点：

- 护栏状态在**单次 run 内**维护，`guardSimpleTask` 只在 run 开始时按首个用户 prompt 判定一次
- guidance 走的是 [运行中引导注入](guidance-injection-design.md) 同款的 `user` 消息通道，并同时落 run 事件与 `.suncode/diagnostics` 里程碑
- **放松**（`turnCount + 3`）与**收紧**（`turnCount + 2`）都写 `loopTurnLimit`，且都受 `configuredLoopTurnLimit` 约束

---

## 与其它机制的分工

| 机制 | 覆盖对象 | 手段 |
|---|---|---|
| 进度护栏（本篇） | 简单任务陷在调查阶段 | 提醒 + 收紧轮次 |
| Plan Gate / 断路器 | 有计划但步骤未完成 | 拦截 `task_complete` + 强制继续 |
| Completion Gate | 改了文件但缺验证证据 | 要求证据 + 一次 repair |
| Goal 自主循环 | 需多轮自动验证重试 | 外层循环 + 反馈注入 |

四者互补：护栏管"迟迟不动手"，其余管"动手了但没收尾"。前两者见 [任务规划系统](task-planning-system.md)，后两者见 [任务结束判断机制](task-completion-mechanism.md)。

---

## 关键约束

1. **门控严格** — 未经 `isSimpleTask` 判定为真的 prompt，护栏完全不启用
2. **一次性动作** — 提醒与硬限各只触发一次；`investigationTurns` 不会导致重复 guidance
3. **成功写入解除** — `edit` / `write` 成功即清零并解除，不误伤"调查够了之后正常大改"的流程
4. **阈值固定** — 8 / 12 / 2 为常量，无配置面

---

## 相关源码

| 模块 | 路径 |
|---|---|
| 护栏状态机与阈值 | `src/worker/agent/progress-guard.ts` |
| 简单任务分类与策略 | `src/worker/agent/task-policy.ts` |
| 接线点 | `src/worker/agent/agent-loop.ts` |
| 测试 | `test/agent/task-controls.test.ts` |
