# 运行中引导注入设计

## 1. 设计目标

用户在与 agent 对话时，经常需要在 agent 正在运行的过程中追加指令（引导），例如修改输出格式、微调策略、或切换到另一条思路。传统方案有两种：

- **排队等回答完再发**：引导生效滞后，用户等待时间长
- **中断后重发**：放弃当前 run 的进度（已执行的操作、已返回的工具数据全部丢失），修改的是"下一轮回答"而非"当前回答的后续"

设计目标：让**引导在运行中即时生效，不中断当前 run 的执行，不篡改已输出的历史内容**。

### 核心原则

| 原则 | 说明 |
|------|------|
| **上下文连续性** | 历史对话、已执行操作、工具返回数据全部留存，不重置会话 |
| **即时生效** | 下一轮思考/输出立刻遵循新指令，不用重启任务 |
| **动态叠加** | 可多次插入多层引导，后插入指令优先级高于旧引导 |
| **不篡改历史** | 已经生成、输出的内容不会回溯修改，只约束后续步骤 |

---

## 2. 架构概览

```
用户输入 "后面所有回答分两点写【要点】" （agent 忙时）
        │
        ▼
useAgent.send() → isBusy=true → enqueuePrompt(text) [队列]
        │
  "引导" 按钮点击
        │
        ▼
useAgent.injectGuidance(id) → takePrompt(id)
        │
        ▼
bridge.injectGuidance(text, uiLanguage)
        │
        ▼
[IPC] agent:injectGuidance
        │
        ▼
[Worker] Agent.injectGuidance(text)
        只入队 guidanceQueue[]，不 abort
        │
        ▼
[AgentLoop] 每轮 turn 顶部 drainGuidance()
        │   若队列非空 → 转成 user Message
        │              → push 进 this.messages
        │              → push 进 contextMessages
        │              → emit guidance_injected (stream + run event)
        ▼
下一轮模型请求的 contextMessages 末尾=引导 user 消息 → 模型看到引导
```

### 2.1 对比：旧方案 vs 新方案

```
旧方案 (interruptAndSend):
  用户引导 → abortController.abort() → run_aborted → 半成品丢弃
  → finishCurrentResponse() → dispatch(引导) → 新 run
  损失：已执行的工具结果丢失，已流式的输出在 UI 残留

新方案 (injectGuidance):
  用户引导 → guidanceQueue.push(引导文本)
  → 当前 turn 继续 → 下一轮 turn 顶部 drainGuidance()
  → contextMessages.push(引导 user 消息)
  → 模型下一轮响应遵从引导
  保留：历史、工具结果、已流式输出全部完整
```

---

## 3. 数据流详解

### 3.1 核心概念

每个 Agent 实例维护一个 `guidanceQueue`：

```typescript
// src/worker/agent/agent.ts
private guidanceQueue: { text: string; uiLanguage: UiLanguage }[] = [];
```

- **入队**：`injectGuidance(text, uiLanguage?)` 只做入队（幂等、无锁），绝不接触 `abortController`
- **出队**：由 AgentLoop 在每轮 turn 边界调用 `drainGuidance()` 一次性取出全部待处理引导

### 3.2 两个 drain 点

```
while (turnCount < maxTurns) {
  turnCount++
  turn_start  ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
  drainGuidance()  ← 注入点 ①：本轮模型请求前     │
  │                                                 │  如果在此处 drain
  try {                                             │  出引导，模型立刻
    model request → 流式 → 判断 decision           │  看到，适用"上一轮
    │                                               │  或运行前注入的引导"
    if decision === 'stop':
      push interim assistant msg
      drainGuidance() ← 注入点 ②：stop 决策边缘   │
      if drained:                                   │  如果在此处 drain
        push to contextMessages                     │  出引导，说明引导
        continue  ← 多跑一轮处理引导                │  在末轮期间注入，
      else:                                         │  适用"末轮保护"
        message_end + return                        │
    │
    if toolCalls: execute tools
    prepareNextTurn (压缩)
}
```

**注入点 ① — 每轮 turn 顶部**（`agent-loop.ts`，turn_start 之后、try 之前）：
- 处理排队中的引导，推入 `contextMessages`
- 本轮模型请求的 `messages` 末尾即为引导 user 消息
- 覆盖场景：引导在前一轮 turn 执行期间注入，或运行前已入队

**注入点 ② — stop 决策边缘**（`agent-loop.ts`，stop 分支内、hooks 之前）：
- 处理本轮流式期间注入的引导（末轮保护）
- 先把本轮已流式的 assistant 回答 push 进 `contextMessages`（不篡改历史）
- 再把引导 push 进去 → `continue` 进入下一轮
- 覆盖场景：用户在 final turn 期间注入引导

### 3.3 Event 序列

Worker 侧在 drain 时通过 `onStream` 和 `onRunEvent` 发出事件：

```typescript
// stream event: 告诉渲染器在 inline-trace 中显示引导 chip
onStream({ type: 'guidance_injected', text: '后面所有回答分两点写【要点】' })

// run event: 写入 JSONL 日志，供事后回溯
onRunEvent({ type: 'guidance_injected', runId, text, timestamp })
```

渲染器收到 `guidance_injected` 后：

1. 在当前 streaming assistant 消息的 `blocks[]` 中追加 `guidance` 类型 block
2. 通过 `bridge.saveMessage` 立即持久化一条 `role: 'user'` 消息（注入时落盘原则）

---

## 4. 渲染呈现

### 4.1 流式态（任务进行中）

引导以 `↳ 引导：xxx` chip 的形式出现在当前 assistant 消息的 InlineCallTrace 中：

```
▸ 处理中 5s
  思考...
   ↳ 引导：后面所有回答分两点写【要点】   ← 引导 chip（蓝色左边框）
  【要点】
  1. ...
  2. ...
```

样式：蓝色左边框 + 浅蓝背景 + 紧凑显示，不打断流式布局。

### 4.2 完成态（任务结束后）

引导块在 InlineCallTrace 中显示为类似的 `↳ 引导：xxx` 行（略淡色调）。不插入独立 user 气泡。

### 4.3 下次加载会话

持久化的 `role: 'user'` 消息会正常渲染为 user 气泡，出现在对应 assistant 消息之前：

```
User: 帮我介绍西瓜籽能不能吃
Assistant: [turn1 搜索... turn2 回答...]
User: 后面所有回答分两点写【要点】           ← 引导（重新加载后）
Assistant: 【要点】1. ... 2. ...
```

---

## 5. 关键实现细节

### 5.1 injectGuidance 方法

```typescript
// src/worker/agent/agent.ts
injectGuidance(text: string, uiLanguage?: UiLanguage): void {
  const trimmed = text?.trim();
  if (!trimmed) return;
  this.guidanceQueue.push({
    text: trimmed,
    uiLanguage: uiLanguage ?? this.currentResponseLanguage,
  });
  // NO abort, NO controller manipulation, NO event emission
  // Pure queue push — idempotent, no lock needed.
}
```

### 5.2 drainGuidance 方法

```typescript
drainGuidance(): Message[] {
  if (this.guidanceQueue.length === 0) return [];
  const items = this.guidanceQueue.splice(0); // 一次性取出
  const messages: Message[] = [];
  for (const item of items) {
    const msg: Message = {
      role: 'user',
      content: [{ type: 'text', text: item.text }],
      uiLanguage: item.uiLanguage,
    };
    this.messages.push(msg);   // ← 追加进跨 run 历史
    messages.push(msg);
  }
  return messages; // 由 loop 推入 contextMessages
}
```

### 5.3 Worker Handler

`agent-worker.ts` 中 `case 'injectGuidance'` 不经过 `withSessionLock`：

```typescript
case 'injectGuidance': {
  const sid = msg.sessionId;
  // Direct call — no lock: injectGuidance() only pushes to a queue,
  // which is idempotent and must take effect at the next turn boundary.
  getAgent(sid)?.injectGuidance(msg.text, msg.uiLanguage);
  break;
}
```

与 `abort`/`stop` 同理——关键中断/注入通道必须绕过 session 锁，确保即使当前 prompt 被锁住也能立即生效。

### 5.4 IPC 通道

| 层 | 文件 | 通道名 |
|---|---|---|
| Preload | `src/main/preload.ts` | `ipcRenderer.send('agent:injectGuidance', text, uiLanguage)` |
| Main | `src/main/ipc-handlers.ts` | `ipcMain.on('agent:injectGuidance', ...)` → `sendToWorker({type:'injectGuidance', ...})` |
| Worker | `src/worker/agent-worker.ts` | `agent.injectGuidance(text, uiLanguage)` |
| Bridge | `src/renderer/api/bridge.ts` | `api().injectGuidance(text, uiLanguage)` |
| SuncodeApi | `src/renderer/types/ipc.ts` | `injectGuidance(text, uiLanguage?)` |

### 5.5 持久化策略

D4（注入时即落盘）：
- 渲染器收到 `guidance_injected` 事件后，立即调用 `bridge.saveMessage({role:'user', content, uiLanguage})`。
- 引导作为 user 消息写入 session JSON，即使 run 中途崩溃也不丢失。
- 渲染器不通 `addUserMessage`（避免重排正在流式的消息）。

---

## 6. 测试策略

测试文件：`test/agent/guidance-injection.test.ts`

| 测试用例 | 验证内容 |
|----------|----------|
| 运行前入队 → turn 1 drain | drain → contextMessages 末尾是引导，loop 正常 stop，不 abort |
| 末轮期间注入 → stop-edge drain → 多跑一轮 | turn 2 的 contextMessages 含 turn1 回答 + 引导，决策正常 stop |
| `guidance_injected` 事件发射 | stream event ×1 / run event ×1 per 引导 |
| FIFO 堆叠 | 多条引导按序追加，后者更靠近模型注意末端 |
| Agent 级 injectGuidance → drainGuidance | this.messages 同步增长，二次 drain 为空，不冒 abort |

---

## 7. 相关文件

| 模块 | 路径 |
|------|------|
| 类型定义 | `src/shared/types.ts`（WorkerInMessage / StreamEvent / RunEvent） |
| Agent 核心 | `src/worker/agent/agent.ts`（injectGuidance / drainGuidance / guidanceQueue） |
| Agent 循环 | `src/worker/agent/agent-loop.ts`（两个 drain 注入点 + streamImpl 测试缝） |
| Worker 入口 | `src/worker/agent-worker.ts`（case 'injectGuidance'） |
| IPC 处理 | `src/main/ipc-handlers.ts` / `src/main/preload.ts` |
| Bridge | `src/renderer/api/bridge.ts` |
| 聊天状态 | `src/renderer/stores/chat.ts`（guidance block + handleStreamEvent） |
| InlineTrace | `src/renderer/components/chat/call-trace-view-model.ts` + `InlineCallTrace.vue` |
| 引导按钮 | `src/renderer/components/chat/PendingPromptQueue.vue` / `ChatPanel.vue` |
| 引导动作 | `src/renderer/composables/useAgent.ts`（injectGuidanceAction） |
| 测试 | `test/agent/guidance-injection.test.ts` |
