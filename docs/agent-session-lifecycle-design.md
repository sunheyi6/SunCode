# Agent 会话生命周期设计

日期: 2026-09-17 | 状态: 已实现

---

## 概述

Worker 线程内以 `Map<sessionId, Agent>` 支撑**多会话并发**：每个 session 拥有独立 Agent 实例，可并行运行、互不串扰。同一 session 内会**变更 Agent 状态**的操作由 `withSessionLock` 串行化；而中断类操作（abort / soft stop）**不加锁**，以保证能立即打断正在跑的 run。

**核心原则：**

- **一会话一实例**：`Agent` 不再是单例，状态按 sessionId 隔离
- **消息按 sessionId 路由**：所有出站消息都盖 sessionId
- **变更加锁、中断免锁**：串行化竞态，但不能阻塞中断
- **软停止可收尾**：停止不是丢弃，而是让模型总结已完成的改动

---

## 多 Session 并发

Worker 入口 `agent-worker.ts` 维护三张表：

| 表 | 键 | 值 |
|---|---|---|
| `agents` | sessionId | `Agent` 实例 |
| `agentWorkingDirs` | sessionId | 工作目录 |
| `sessionLocks` | sessionId | 串行化 Promise 链 |

`createCallbacks(sessionId)` 为每个 session 生成一套回调，**每条出站消息都盖章 sessionId**（`stream` / `status` / `toolStart` / `toolEnd` / `toolProgress` / `done` / `error` / `runEvent` …），Renderer 据此把事件投递到正确的会话。

Agent 在 `setWorkingDir` 首次收到某 session 时惰性创建（若已存在则只更新工作目录）；工作目录未变化时直接跳过。`config` 消息则广播到**所有** Agent 实例（`updateSettings`）。

后台进程由 `BackgroundProcessMonitor` 按 session 归属登记，`bgProcessStarted` / `bgProcessCompleted` / `bgProcessPortsVerified` 事件同样带 sessionId。

---

## SessionLock（串行化）

~~~typescript
const sessionLocks = new Map<string, Promise<void>>();

function withSessionLock(sessionId: string, fn: () => Promise<void>): void {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn).then(() => {
    if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
  });
  sessionLocks.set(sessionId, next);
}
~~~

要点：

- `prev.then(fn, fn)` 表示**前一个链节无论成功或失败都继续**，避免一次异常卡死整个会话队列
- 链尾执行完即清理表项（仅当自己仍是最新链节时），防止内存泄漏

**加锁范围（变更状态）：** `prompt` / `continue` / `setWorkingDir`。

**免锁范围（必须即时生效）：** `abort` / `stop`（软停止）/ `injectGuidance`。三者的共同点是**只设标志或入队、幂等，且必须立刻打断正在跑的 prompt**——若排在长 run 的锁后面就失去意义。

| 消息 | 加锁 | 理由 |
|---|---|---|
| `prompt` | 是 | 与 continue/切目录竞态 |
| `continue` | 是 | 同上 |
| `setWorkingDir` | 是 | 变更 Agent 工作目录 |
| `abort` | 否 | 幂等标志 + abort，须即时 |
| `stop` | 否 | 软停止，须即时 |
| `injectGuidance` | 否 | 仅入队，下一回合生效 |

---

## 软停止（Soft Stop）

点击停止按钮走的是**软停止**，区别于硬 abort：中断当前模型调用后，再注入一个纯文本回合让模型总结。

~~~typescript
requestStop(): void {
  this.stopRequested = true;
  this.abortController?.abort();
}
~~~

`runStopSummary()` 的执行要点：

1. **重置每-run 计数**：`turnCount = 0`、`activeRunTokens = 0`；否则 `while (turnCount < maxTurns)` 会立即退出，总结退化成空的占位消息
2. **追加总结请求**：以 user 消息注入"用户停止了对话。请简要总结你刚才完成的操作和改动。"
3. **单轮纯文本**：`runLoop(runId, true)`，`summaryMode` 下工具列表为空、轮次上限为 1
4. **落 run 事件**：`run_started` + `turn.prompt`（`input: '[stop-summary]'`）；若总结期间被再次中断则记 `run_aborted`
5. **收尾**：`finally` 中 `isRunning = false`、清空 `abortController`，并 `flushMemoryAccessCounts()` 落盘记忆访问计数

| 维度 | 硬 abort | 软停止 |
|---|---|---|
| 触发 | `abort()` | `requestStop()` |
| 流 | 立即中断、无收尾 | 中断后追加一轮总结 |
| 产出 | 无总结 | 一段纯文本"已完成操作" |
| 用途 | 切会话、异常终止 | 用户主动停下并想留下交代 |

---

## 会话切换

切换 session 时**先 abort 当前 run**，再做 `setMessages`。原因：若旧 run 仍在写回消息，`setMessages` 会被静默忽略，导致新会话消息丢失。

---

## 关键约束

1. **实例隔离** — Agent 按 sessionId 一实例，不共享消息与运行态
2. **盖章路由** — 所有出站消息必带 sessionId
3. **锁不阻塞中断** — 仅变更类操作加锁，中断类操作直连
4. **链节容错** — `then(fn, fn)` 保证前序失败不卡住队列
5. **总结回合独立** — 软停止的总结是一轮全新 run，计数必须重置

---

## 相关源码

| 模块 | 路径 |
|---|---|
| Worker 入口 / 多 Session / SessionLock | `src/worker/agent-worker.ts` |
| 软停止与总结 | `src/worker/agent/agent.ts`（`requestStop` / `runStopSummary` / `summaryMode`） |
| Agent 循环 | `src/worker/agent/agent-loop.ts` |
| 后台进程监控 | `src/worker/tools/background-process-monitor.ts` |
| 进程树 kill | `src/worker/tools/bash.ts`（`killProcessTree`） |
