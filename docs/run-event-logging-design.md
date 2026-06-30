# Run Event JSONL 日志设计文档

## 1. 背景

Agent 每次运行产生的事件（turn 开始/结束、工具调用、模型请求、LLM 输出片段等）需要持久化，用于：

- **调用链回溯（CallTracePanel）**：渲染 UI 端查看每次运行的完整执行轨迹
- **运行中断恢复**：应用重启时检测未完成运行，打上 `run_recovered` 标记
- **Token 用量统计**：按日/模型汇总 token 消耗
- **未来扩展**：运行回放、性能分析、失败诊断

设计参考了 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) 的 `wire.jsonl` 方案，取其核心思想并适配 SunCode 现有架构。

---

## 2. 设计目标

- **自描述**：每行一条 JSON，无需额外 schema 文件即可解析
- **可追加**：JSONL 天然支持流式追加，不重写整个文件
- **向后兼容**：新增字段全部可选，旧日志文件可正常读取
- **协议版本化**：文件首行标注 `protocol_version`，未来 schema 变更可追溯
- **分层记录**：run 级事件（开始/结束）⇢ turn 级事件（LLM 调用）⇢ tool 级事件（工具执行）⇢ content 级事件（输出片段）

---

## 3. 存储路径

```
%APPDATA%/SunCode/.suncode/
├── sessions/
│   └── <sessionId>/
│       └── runs/
│           └── <runId>.jsonl      ← 每次运行的 JSONL 事件日志
└── token-usage.json               ← Token 用量汇总
```

子 Agent 的运行事件写入独立的 `<subagentExecutionId>.jsonl` 文件，位于同一 `runs/` 目录下。

---

## 4. 事件类型总览

### 4.1 协议元数据（首行）

```json
{
  "type": "metadata",
  "protocol_version": 1,
  "created_at": 1719600000000
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `protocol_version` | `number` | 是 | 事件 schema 版本号，breaking change 时递增 |
| `created_at` | `number` | 是 | Unix 毫秒时间戳，文件创建时间 |

`metadata` 事件由 `startRun()` 在创建 JSONL 文件时写入首行。读取时（`getEvents()`）自动跳过该行，上层无需关心。

### 4.2 Run 生命周期事件

| 事件 | 触发点 | 关键字段 |
|------|--------|----------|
| `run_started` | Agent.prompt() / Agent.continue() | `runId`, `modelName` |
| `turn.prompt` | 紧随 `run_started` | `runId`, `input` (用户原始输入) |
| `run_completed` | runAgentLoop 正常退出 | `runId`, `turnCount`, `tokenUsage`, `taxonomy` |
| `run_failed` | Agent 抛出未捕获异常 | `runId`, `error` |
| `run_aborted` | 用户手动中止 | `runId` |
| `run_recovered` | 启动恢复扫描发现残留运行 | `runId`, `reason` |

### 4.3 Turn 内事件

| 事件 | 触发点 | 关键字段 |
|------|--------|----------|
| `turn_started` | 每次 LLM 调用前 | `runId`, `turnNumber` |
| `model_request_started` | 调用 `pi-ai` 前 | `runId`, `turnNumber`, `attempt`, `provider`, `model` |
| `model_request_completed` | LLM 流式响应结束时 | + `durationMs`, `firstTokenLatencyMs`, `streamDurationMs`, `inputTokens`, `outputTokens`, `stopReason`, `requestMessages`, `responseText`, `responseThinking`, `responseToolCalls` |
| `turn_completed` | LLM 决策停止 / 本轮被阻止 | `runId`, `turnNumber`, `hasToolCalls`, `taxonomy` |

### 4.4 Content 事件

```json
{
  "type": "content.part",
  "runId": "abc123",
  "turnNumber": 1,
  "part": { "kind": "text", "text": "我来帮你分析..." },
  "timestamp": "2026-06-29T10:00:00.000Z"
}
```

或

```json
{
  "type": "content.part",
  "runId": "abc123",
  "turnNumber": 1,
  "part": { "kind": "thinking", "thinking": "用户想读取文件，我需要..." },
  "timestamp": "2026-06-29T10:00:00.000Z"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `part.kind` | `'text' \| 'thinking'` | 是 | 输出类型 |
| `part.text` / `part.thinking` | `string` | 是 | 该 segment 的完整内容 |

每个 LLM 流式输出中的 `text_end` / `thinking_end` 事件触发一次 `content.part` 写入。如果模型先输出文本再输出工具调用再输出文本，会有多个 `content.part` 事件（各自独立累加，不重复）。

相较于只依赖 `model_request_completed.responseText` 的粗粒度记录，`content.part` 的优势：
- 崩溃时至少保留已输出的部分
- 可按 segment 重建输出时间线

### 4.5 Tool 事件

#### `tool_started`

```json
{
  "type": "tool_started",
  "runId": "abc123",
  "toolCallId": "call_1",
  "toolName": "read",
  "arguments": "{\"file_path\":\"D:\\\\package.json\"}",
  "description": "read(file_path=D:\\package.json)",
  "timestamp": "2026-06-29T10:00:01.000Z"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `toolCallId` | `string` | 是 | LLM 返回的 tool_call id |
| `toolName` | `string` | 是 | 工具名称 |
| `arguments` | `string?` | 否 | JSON 字符串形式的参数 |
| `description` | `string?` | 否 | 人类可读的一句话描述，从 args 自动生成，长内容自动截断，敏感内容脱敏 |

#### `tool_completed`

```json
{
  "type": "tool_completed",
  "runId": "abc123",
  "toolCallId": "call_1",
  "toolName": "read",
  "success": true,
  "output": "{\"name\":\"suncode\",...}",
  "truncated": false,
  "message": "OK: read",
  "timestamp": "2026-06-29T10:00:02.500Z"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `success` | `boolean` | 是 | 工具执行是否成功 |
| `output` | `string?` | 否 | 工具输出（截断至 2000 字符） |
| `error` | `string?` | 否 | 错误信息（截断至 500 字符） |
| `truncated` | `boolean?` | 否 | 原始输出是否超过 2000 字符被截断 |
| `message` | `string?` | 否 | 附注摘要，如 `"OK: read"`, `"FAIL: bash — exit code 1"`, `"CRASH: glob — timeout"` |

### 4.6 Goal 事件

| 事件 | 触发点 | 关键字段 |
|------|--------|----------|
| `goal_started` | /goal 前缀被检测到时 | `runId`, `goal: GoalDefinition` |
| `goal_turn_completed` | Goal 循环中每轮完成 | `runId`, `turnNumber`, `verificationExitCode` |
| `goal_completed` | Goal 循环结束 | `runId`, `status: GoalStatus` |

### 4.7 Stream 事件

| 事件 | 触发点 | 关键字段 |
|------|--------|----------|
| `stream_event` | 每次 UI 流式事件 | `runId`, `event: StreamEvent` |

用于保留原始 UI 事件流，供回放或诊断使用。

---

## 5. 数据流

```
User Input
    │
    ▼
Agent.prompt()                  [src/worker/agent/agent.ts]
    ├─ emit run_started
    ├─ emit turn.prompt          ← 新增：记录用户原始输入
    │
    ▼
runAgentLoop()                  [src/worker/agent/agent-loop.ts]
    │
    ├─ for each turn:
    │   ├─ emit turn_started
    │   ├─ emit model_request_started
    │   │
    │   ├─ LLM Stream (pi-ai):
    │   │   ├─ text_delta / thinking_delta     → aggregate into segmentText/segmentThinking
    │   │   ├─ text_end / thinking_end          → emit content.part      ← 新增：记录输出片段
    │   │   └─ done                             → emit model_request_completed
    │   │                                          (含 firstTokenLatencyMs, streamDurationMs)  ← 新增：LLM 延迟指标
    │   │
    │   ├─ if decision == 'stop':
    │   │   └─ emit turn_completed
    │   │
    │   └─ if tool_calls:
    │       ├─ for each tool:
    │       │   ├─ emit tool_started            (含 description)          ← 增强
    │       │   ├─ tool.execute()
    │       │   └─ emit tool_completed          (含 truncated, message)   ← 增强
    │       └─ emit turn_completed (hasToolCalls=true)
    │
    ▼
Agent (onRunEvent callback)     [src/worker/agent/agent.ts]
    │
    ▼
Worker postMessage()            [src/worker/agent-worker.ts]
    │
    ▼
Main Process IPC Handler        [src/main/ipc-handlers.ts]
    ├─ startRun()                → 写入 metadata 首行 + 创建 runs 目录 ← 新增
    ├─ appendEvent()             → 追加 JSONL 行 + 更新 token-usage.json
    └─ forward to Renderer       → CallTracePanel 消费
```

子 Agent 运行事件原先被丢弃（no-op），现已改为转发：

```
SubagentDispatcher.execute()    [src/worker/agent/subagent.ts]
    └─ runAgentLoop(onRunEvent)  → 转发至 this.opts.callbacks.onRunEvent
                                       └─ Agent.onRunEvent → Worker → Main → JSONL
```

---

## 6. 与 Kimi-Code 的对齐

| 设计点 | Kimi-Code | SunCode |
|--------|-----------|---------|
| 协议版本 | `metadata` 首行 `protocol_version` | ✅ 已实现 |
| Loop 事件 | `context.append_loop_event` wrapper | ❌ 暂不引入 wrapper（破坏性改动） |
| 内容片段 | `content.part` → text/think | ✅ 已实现，在 `text_end`/`thinking_end` 触发 |
| 工具调用 | `tool.call` → `description`, `display` | ✅ `tool_started` 新增 `description` |
| 工具结果 | `tool.result` → `isError`, `truncated`, `message`, `stopTurn` | ✅ `tool_completed` 新增 `truncated`, `message`；已有 `success` |
| LLM 延迟 | `step.end` → `llmFirstTokenLatencyMs`, `llmStreamDurationMs` | ✅ 在 `model_request_completed` 中新增 |
| 用户输入 | `turn.prompt` | ✅ 已实现，紧随 `run_started` |
| 子 Agent 日志 | 独立 `wire.jsonl` 文件 | ✅ 子 Agent 事件现在会写入独立文件 |
| 全生命周期 | `config.update`, `permission.set_mode`, `compaction` 等 | ❌ 后续按需添加 |
| 状态回放 | `replay()` 基于 wire.jsonl 恢复 Agent 状态 | ❌ 暂不需要（仅用于日志记录） |

---

## 7. 向后兼容性

### 7.1 读取旧文件

`getEvents()` 对旧 JSONL 文件（无 `metadata` 首行）完全兼容：

```typescript
// 逐行解析，metadata 行跳过，损坏行返回 run_recovered 标记
for (const line of lines) {
  const parsed = JSON.parse(line) as RunEvent;
  if (parsed.type === 'metadata') continue;
  events.push(parsed);
}
```

### 7.2 新字段向后兼容

所有新增字段均为可选（`?`），旧解析器不会因为多出字段而报错：
- `tool_started.description`
- `tool_completed.truncated`
- `tool_completed.message`
- `model_request_completed.firstTokenLatencyMs`
- `model_request_completed.streamDurationMs`

### 7.3 findStaleRuns() 兼容

`findStaleRuns()` 排除 `metadata` 类型（因为 `getEvents()` 已过滤掉 metadata 行），不受影响。

---

## 8. 未来扩展

以下项不在当前范围内，但 schema 预留了扩展空间：

- **完整的 Agent 生命周期事件**：`config.update`, `permission.set_mode`, `compaction.begin/complete`, `plan_mode.enter/exit` 等（参考 kimi-code `AgentRecordEvents`）
- **事件外层统一 wrapper**：`{ type: 'context.append_loop_event', event: {...} }` 形式，将所有 loop 事件归一化
- **基于 JSONL 的运行回放（Replay）**：读取 wire 文件恢复 Agent 状态，支持崩溃后续跑
- **子 Agent 独立目录**：`agents/<agentId>/runs/<runId>.jsonl` 按 agent 分目录
- **Token 用量字段扩展**：`model_request_completed` 增加 `cacheReadTokens`, `cacheWriteTokens` 等细粒度字段

---

## 9. 相关文件

| 文件 | 职责 |
|------|------|
| `src/shared/types.ts` | `RunEvent` 类型定义、`WIRE_PROTOCOL_VERSION`、`ContentPart` 类型 |
| `src/main/run-store.ts` | JSONL 文件读写、metadata 写入、token 用量汇总 |
| `src/main/ipc-handlers.ts` | Worker IPC 事件路由至 `appendEvent()` |
| `src/worker/agent/agent-loop.ts` | `content.part` 发射、tool 字段填充、LLM 延迟计算 |
| `src/worker/agent/agent.ts` | `turn.prompt` 发射、子 Agent 回调赋值 |
| `src/worker/agent/subagent.ts` | 子 Agent 事件转发 |

---

## 10. 变更日志

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-06-29 | 1 | 初始版本：metadata 首行、content.part、tool description/truncated/message、LLM 延迟指标、turn.prompt、子 Agent 事件传播 |
