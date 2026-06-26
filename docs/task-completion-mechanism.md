# 任务结束判断机制 — 设计文档

## 1. 设计目标

SunCode 最初的任务结束判断依赖两个机制：

- **`task_complete` 工具**：模型显式调用表示完成
- **`isIncompleteProgressText()` 启发式检测**：当模型输出"还需要…""让我继续…"等文本但未调用工具时，注入纠正提示并继续

实际使用中暴露出两个问题：

1. **模型经常"忘记"调用 `task_complete`**，而是直接输出文本就停止了。由于 `isIncompleteProgressText()` 是纯正则匹配，漏判和误判都频繁发生。
2. **缺乏自主多轮能力**：一次 `prompt()` 只有一轮 agent loop，不能在多轮之间自动验证和重试。

本设计的三个模块（统一借鉴 Codex 和 maka-agent 的设计）解决这两个问题：

| 模块 | 解决的问题 |
|------|-----------|
| `needs_follow_up` 决策重构 | 用结构化决策替代启发式文本检测 |
| `/goal` 自主循环 | 证据驱动的多轮自动重试 + 验证 |
| Stop Hooks | 可扩展的 turn 结束前拦截检查 |

---

## 2. 整体架构

```
用户输入
    │
    ├── 普通 prompt ──────────────────────────────────────────┐
    │                                                          │
    ├── /goal prompt ──────────────────────┐                   │
    │                                       │                   │
    ▼                                       ▼                   ▼
┌───────────────────┐              ┌───────────────────┐  ┌──────────────────┐
│  runGoalLoop()    │              │  runAgentLoop()   │  │  runAgentLoop()  │
│  (goal-loop.ts)   │              │  (agent-loop.ts)  │  │  (agent-loop.ts) │
│                   │              │                   │  │                  │
│  外层: 每轮调用   │              │  内层: while turn  │  │  内层: while     │
│  ┌─────────────┐  │              │  ┌──────────────┐ │  │  ┌─────────────┐ │
│  │runAgentLoop │  │              │  │ LLM stream    │ │  │  │ LLM stream  │ │
│  │    ↓        │  │              │  │      ↓        │ │  │  │     ↓       │ │
│  │ verification│  │              │  │ tool execute  │ │  │  │ tool exec   │ │
│  │    ↓        │  │              │  │      ↓        │ │  │  │     ↓       │ │
│  │ feedback →  │──┤  继续        │  │needs_follow_up│ │  │  │ needs_follow │ │
│  │  continue   │  │              │  │      ↓        │ │  │  │     ↓       │ │
│  └─────────────┘  │              │  │ stop hooks    │ │  │  │ stop hooks   │ │
│       ↓            │              │  │      ↓        │ │  │  │     ↓       │ │
│   verification     │              │  │ return result │ │  │  │ return       │ │
│   passed → stop    │              │  └──────────────┘ │  │  └─────────────┘ │
└───────────────────┘              └───────────────────┘  └──────────────────┘
```

**两层循环**：

| 层级 | 文件 | 职责 |
|------|------|------|
| **外层**（Goal 循环） | `goal-loop.ts` | 管理多次 agent run，每轮后运行验证，注入反馈 |
| **内层**（Agent 循环） | `agent-loop.ts` | 单次 LLM 交互的 turn-by-turn 循环 |

---

## 3. 模块 1：`needs_follow_up` 决策重构

### 3.1 核心类型

```typescript
// src/shared/types.ts

export type TurnTaxonomy =
  | 'completed'           // 正常完成
  | 'max_turns_exhausted' // 轮次耗尽
  | 'aborted'             // 用户中止
  | 'blocked'             // Stop Hook 拦截
  | 'error';              // 流/LLM 错误

export type TurnDecision =
  | { decision: 'continue'; reason?: string }
  | { decision: 'stop'; reason: 'task_complete' | 'no_follow_up' | 'max_turns' | 'aborted' | 'blocked' | 'error'; taxonomy: TurnTaxonomy };
```

### 3.2 决策函数

```typescript
// src/worker/agent/turn-decision.ts

export function computeNeedsFollowUp(input: NeedsFollowUpInput): {
  needsFollowUp: boolean;
  decision: TurnDecision;
} {
  // 优先级：abort > task_complete > tool calls > pending input > max turns > natural stop

  if (input.isAborted)    → { needsFollowUp: false, decision: { reason: 'aborted', taxonomy: 'aborted' } }
  if (input.hasTaskComplete) → { needsFollowUp: false, decision: { reason: 'task_complete', taxonomy: 'completed' } }
  if (toolCalls.length > 0) → { needsFollowUp: true,  decision: 'continue' }
  if (input.hasPendingInput) → { needsFollowUp: true,  decision: 'continue' }
  if (input.isMaxTurnsReached) → { needsFollowUp: false, decision: { reason: 'max_turns', taxonomy: 'max_turns_exhausted' } }
  default                  → { needsFollowUp: false, decision: { reason: 'no_follow_up', taxonomy: 'completed' } }
}
```

### 3.3 与旧逻辑的对比

| 场景 | 旧逻辑 | 新逻辑 |
|------|--------|--------|
| 模型输出文本 + `task_complete` | 拦截 tool，提取 summary | 同，但增加 `TurnDecision` 返回值 |
| 模型输出文本 + 无 tool call | `isIncompleteProgressText()` 正则检测 → 注入纠正提示 | `computeNeedsFollowUp()` 判定 → `no_follow_up`，自然停止 |
| 模型输出"还需要修复…" | 正则匹配到 → 注入纠正提示 | **不再拦截**，因为模型没调 tool = 它决定停了 |
| 用户排队了新的 prompt | 不感知 | `hasPendingInput: true` → 继续循环 |
| 轮次耗尽 | while 条件退出，返回错误消息 | 同，但增加 `taxonomy: 'max_turns_exhausted'` |

### 3.4 设计取舍

**移除 `isIncompleteProgressText()` 启发式检测**。理由：

- Codex 的做法是让模型自然表达意图：发 tool call = 继续，不发 = 停止。不依赖文本启发式。
- 正则匹配无法覆盖所有场景，误判修复比误判漏掉更糟糕（注入错误纠正提示会干扰模型）。
- Stop Hooks 中的 `CompletionStopHook` 提供了更可靠的替代：检查回复是否过于简短（<20 字符），而非检查具体的"未完"文本模式。

---

## 4. 模块 2：`/goal` 自主循环

### 4.1 核心类型

```typescript
// src/shared/types.ts

export interface GoalDefinition {
  description: string;            // 目标描述
  verificationCommand?: string;   // 验证命令（exit 0 = 通过）
  constraints?: string;           // 约束条件
  maxGoalTurns?: number;          // 最大 goal 级轮次（默认 5）
  maxWallTimeMs?: number;         // 最大墙上时间（默认 10 分钟）
}

export type GoalStatus =
  | 'active'               // 正在执行
  | 'verification_passed'  // 验证通过
  | 'budget_exhausted'     // 预算耗尽
  | 'blocked'              // 无有效路径
  | 'aborted';             // 用户取消
```

### 4.2 解析用户输入

```typescript
// src/worker/agent/goal-loop.ts

export function parseGoalFromPrompt(text: string): GoalDefinition | null

// 格式: /goal <描述> [--verify "命令"] [--constraints "约束"]
```

解析流程：
```
用户输入: "/goal 修复所有 TS 错误 --verify \"bun run typecheck\" --constraints \"不破坏现有测试\""
    │
    ├── 检查是否以 /goal 开头
    ├── 提取 --verify "bun run typecheck" → verificationCommand
    ├── 提取 --constraints "不破坏现有测试" → constraints
    └── 剩余部分 → description: "修复所有 TS 错误"
```

### 4.3 Goal 循环执行流程

```
runGoalLoop(input)
    │
    ├── 初始化 GoalState { status: 'active', turnsCompleted: 0 }
    ├── 发射 goal_started 事件
    │
    └── while turns < maxTurns && wallTime < maxWallTime:
        │
        ├── 检查 abortSignal.aborted
        ├── 构建带有反馈的历史消息
        ├── 调用 runAgentLoop() — 一次完整的 agent run
        ├── 累加 turnCount + tokenUsage
        ├── 将 finalMessage 推入历史
        │
        ├── 检查模型是否调用了 task_complete（权威完成信号）
        │   ├── 是 → goal 结束 ✅（--verify 降级为辅助日志）
        │   └── 否 → 进入验证/反馈逻辑
        │
        ├── if verificationCommand 存在:
        │   ├── runVerification(command, cwd) → { passed, exitCode, output }
        │   ├── 发射 goal_turn_completed 事件（含验证输出）
        │   ├── if exitCode === null（命令无法运行）→ blocked，停止 🔴
        │   ├── if passed → status = 'verification_passed' → STOP ✅
        │   ├── if 连续两次输出相同 → blocked（系统性错误），停止 🔴
        │   └── else → 注入验证失败反馈 → continue
        │
        └── else (无验证命令):
            ├── 模型未调 task_complete → 注入持续提示 → continue
    │
    └── 循环结束 → 设置最终状态 → 发射 goal_completed 事件
```

**关键设计：`task_complete` 是权威完成信号**

模型调用 `task_complete` 后 goal 立即结束，即使 `--verify` 命令返回非零退出码也只记录 warning 日志。理由：
- 模型能综合判断任务是否真正完成（代码逻辑、文件内容、上下文），外部 shell 命令无法覆盖所有验证场景
- `--verify` 在 Windows/Linux 跨平台时壳语法差异大（如 `2>/dev/null`），作为强制关卡会导致误判死循环

### 4.4 验证命令执行

```typescript
// src/worker/agent/goal-loop.ts

function runVerification(command: string, cwd: string): Promise<VerificationResult>
```

- 通过 `child_process.spawn` 在 workspace 中执行
- Shell: true，detached: true（可杀进程树）
- 超时 120 秒，输出上限 1 MB
- Exit code 0 且未超时 → `passed: true`

### 4.5 反馈构建

验证失败时注入的反馈格式：

```
[目标验证失败 — 第 2/5 次尝试]

验证命令: `bun run typecheck`
退出码: 1

验证输出:
```
src/worker/agent/agent.ts(493,7): error TS2322 ...
```

目标: 修复所有 TS 错误
约束: 不破坏现有测试

请根据以上验证失败的输出，继续修复问题。完成后调用 task_complete。
```

### 4.6 设计取舍

**为什么 `task_complete` 是权威完成信号？**

- 模型能综合判断任务是否真正完成（代码逻辑、文件内容、上下文），外部 shell 命令无法覆盖所有验证场景。
- `--verify` 在 Windows/Linux 跨平台时壳语法差异大（如 `2>/dev/null` 只在 Unix 有效），作为强制关卡会导致误判死循环。
- `--verify` 降级为辅助证据：当模型调了 `task_complete` 时，验证命令只做日志记录；exitCode ≠ 0 时输出 warning 但仍结束。只有当模型未声明完成时，验证命令才作为权威信号。
- 无 `--verify` 时，模型必须显式调用 `task_complete` 才能结束（不会自动停止）。

**为什么不用 maka-agent 的完整 Verifier/Spec/Adapter 体系？**

- maka-agent 的 verifier 支持 `command`、`terminal_bench`、`swe_bench` 三种，后两种是基准测试特化的。
- SunCode 是交互编码助手，不是 benchmark runner。`command` 验证已覆盖核心需求。
- 保留扩展空间：`runVerification()` 的 `VerificationResult` 接口足够通用，未来可添加 `file_exists`、`grep_pattern` 等验证模式。

**为什么 goal loop 是自己调用 `runAgentLoop()` 而不是在 agent-loop 内部实现？**

- 关注点分离：`agent-loop.ts` 只负责单次 run 的 turn-by-turn 逻辑，`goal-loop.ts` 负责多次 run 的编排。
- Goal loop 需要管理自己的 budget、事件发射、消息历史，独立成一个模块更清晰。
- Agent loop 通过 `AgentLoopInput` 接口接收配置，可以被 goal loop 作为黑盒复用。

---

## 5. 模块 3：Stop Hooks

### 5.1 核心接口

```typescript
// src/shared/types.ts

export interface StopHookContext {
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallContent[];
  toolResults: ToolResult[];
  turnCount: number;
  maxTurns: number;
  tokenUsage: TokenUsage;
  goal?: GoalDefinition;
}

export interface StopHookResult {
  shouldBlock: boolean;          // 阻止 turn 结束，注入新 prompt
  shouldStop: boolean;           // 强制终止
  continuationPrompt?: string;   // shouldBlock=true 时注入
  reason?: string;
}

export interface StopHook {
  name: string;
  priority: number;              // 越小越先执行
  check(ctx: StopHookContext): Promise<StopHookResult>;
}
```

### 5.2 执行流程

在 `agent-loop.ts` 中，当 `turnDecision.decision === 'stop'` 时：

```
turnDecision.decision === 'stop'
    │
    ├── stopHooks?.runAll(context)  → 按 priority 升序执行
    │   │
    │   ├── 第一个返回 shouldStop=true 的 hook 胜出 → 强制终止
    │   ├── 第一个返回 shouldBlock=true 的 hook 胜出 → 注入 prompt，continue
    │   └── 所有 hook 返回 false → 正常结束
    │
    └── 后续 hook 不执行（短路）
```

### 5.3 内置 Hooks

| Hook | Priority | 功能 |
|------|----------|------|
| `SafetyStopHook` | 20 | 检测 `rm -rf /`、`sudo rm`、`chmod 777 /`、`git push --force main` 等危险操作 |
| `CompletionStopHook` | 30 | 检测回复长度 < 20 字符且无 tool call → 注入提示要求模型给出完整回答 |

### 5.4 注册机制

```typescript
// src/worker/agent/stop-hooks.ts

export class DefaultStopHookRegistry implements StopHookRegistry {
  private hooks: StopHook[] = [];

  register(hook: StopHook): void {
    this.hooks.push(hook);
    this.hooks.sort((a, b) => a.priority - b.priority);  // 保持排序
  }

  async runAll(ctx: StopHookContext): Promise<StopHookResult> {
    for (const hook of this.hooks) {
      const result = await hook.check(ctx);
      if (result.shouldStop || result.shouldBlock) return result;  // 短路
    }
    return { shouldBlock: false, shouldStop: false };
  }
}
```

### 5.5 设计取舍

**为什么要短路（第一个匹配即返回）而非运行所有 hook？**

- 与 Codex 的 stop hooks 设计一致：如果安全检查要 stop，就不应该再运行后续的"完成检查"。
- 确保 `shouldBlock` 和 `shouldStop` 不会冲突（一个说要继续，另一个说要停止）。
- 通过 `priority` 控制顺序，确保安全检查（p20）优先于完成度检查（p30）。

**为什么不在每次 tool 执行前也运行 hooks？**

- 当前设计聚焦于 turn 结束时的检查。Tool 执行前已有参数校验和白名单机制。
- 如需扩展，`StopHook` 接口可以增加 `checkBeforeTool(ctx, toolCall)` 方法。

---

## 6. 数据流：从 Worker 到 UI

### 6.1 Goal 事件流

```
goal-loop.ts                     agent-worker.ts             ipc-handlers.ts          preload.ts             useAgent.ts
    │                                  │                          │                       │                       │
    ├── onGoalEvent('goal_started')  ──► post('goalEvent')  ──► webContents.send   ──► ipcRenderer.on    ──► agentStore.setGoalActive(true)
    │                                  │                          │    ('agent:goal-event')  │                       │
    ├── onGoalEvent('goal_turn_       ──► post('goalEvent')  ──► ...                 ──► ...               ──► (console.log)
    │       completed')                │                          │                       │                       │
    ├── onGoalEvent('goal_completed') ──► post('goalEvent')  ──► ...                 ──► ...               ──► agentStore.setGoalActive(false)
```

### 6.2 TurnDecision 在 RunEvent 中的记录

每个 `turn_completed` 和 `run_completed` 事件都携带 `taxonomy` 字段：

```typescript
// turn_completed 事件（新增 taxonomy）
onRunEvent({
  type: 'turn_completed',
  runId,
  turnNumber: turnCount,
  hasToolCalls: true,
  timestamp: '',
  taxonomy: 'completed',  // 新增
});

// run_completed 事件（新增 taxonomy）
onRunEvent({
  type: 'run_completed',
  runId,
  turnCount: result.turnCount,
  timestamp: new Date().toISOString(),
  tokenUsage: result.tokenUsage,
  taxonomy: 'completed',  // 新增
});
```

这些记录写入 `.suncode/sessions/<id>/runs/<runId>.jsonl`，供用量统计和会话恢复使用。

---

## 7. 文件变更清单

### 新建文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/worker/agent/turn-decision.ts` | ~90 | `computeNeedsFollowUp()` + 辅助函数 |
| `src/worker/agent/stop-hooks.ts` | ~110 | `SafetyStopHook` + `CompletionStopHook` + `DefaultStopHookRegistry` |
| `src/worker/agent/goal-loop.ts` | ~480 | `runGoalLoop()` + `/goal` 解析 + 验证命令执行 + 系统性错误检测 |

### 修改文件

| 文件 | 改动性质 |
|------|----------|
| `src/shared/types.ts` | 新增 10+ 类型定义，AppSettings 扩展，RunEvent 扩展，WorkerOutMessage 扩展 |
| `src/shared/constants.ts` | 新增 Goal 默认值 + system prompt 中 Goal 模式说明 |
| `src/worker/agent/agent-loop.ts` | 核心重构：`needs_follow_up` 决策 + stop hooks 集成 + AgentLoopResult 扩展 |
| `src/worker/agent/agent.ts` | `/goal` 检测 + `runGoalLoop()` 方法 + stopHooks 传入 |
| `src/worker/agent-worker.ts` | 新增 `onGoalEvent` 回调（第 13 个参数） |
| `src/main/ipc-handlers.ts` | 新增 `goalEvent` case |
| `src/main/preload.ts` | 新增 `onGoalEvent()` API |
| `src/renderer/api/bridge.ts` | 新增 `onGoalEvent()` 方法 |
| `src/renderer/types/ipc.ts` | Window 类型扩展 |
| `src/renderer/composables/useAgent.ts` | Goal 事件监听 |
| `src/renderer/stores/agent.ts` | `goalActive` 状态 |

---

## 8. 经验教训 / Lessons Learned

### 8.1 外部验证命令的跨平台陷阱

初版将 `--verify` 命令的 exit code 作为 goal 完成的唯一关卡。在 Windows 上测试时，用户使用 Unix 语法（`ls ... 2>/dev/null | wc -l`），命令永远失败但 exitCode ≠ null，导致死循环。

**教训**：
- 外部 shell 命令作为强制验证不可靠，跨平台兼容性差
- 应允许模型通过 `task_complete` 自主声明完成，外部验证降级为辅助证据

### 8.2 `buildVerificationFeedback` 语法错误导致崩溃

一次编辑在 `buildVerificationFeedback()` 调用中误写入了三行无效代码（赋值语句作为函数参数），导致验证失败后 worker 直接崩溃，桌面 app 自动关闭。

**教训**：
- 多行编辑时需特别注意括号匹配和作用域边界
- Goal 循环中的 `runAgentLoop` 已有 try-catch 兜底，但验证阶段的代码没被保护

### 8.3 `modelDeclaredDone` 应提升到 if-else 之外

初版在 `if (verificationCommand)` 和 `else` 两个分支中分别检查 `task_complete`，导致逻辑重复。重构后将 `modelDeclaredDone` 提到分支之前统一判断，减少了代码重复和潜在的不一致。

### 8.4 连续相同验证输出 → 系统性错误

当验证命令因环境问题（如缺少依赖）反复失败时，每次输出完全相同。添加了连续两次输出比对逻辑，检测到后立即 `blocked` 停止，避免无意义的无限重试。

### 8.5 所有 Goal 事件应写入 RunEvent 日志

初版只在 `agent.ts` 的 `onGoalEvent` 回调中转发 `goal_started` 和 `goal_completed`，`goal_turn_completed` 等中间事件缺失，导致通过 JSONL 排查问题时看不到验证进度。

**修复**：将所有 goal 事件类型都转发到 `RunEvent`，方便后续会话分析和问题排查。

---

## 9. 设计原则总结

1. **向后兼容**：普通 `prompt()` 行为不变，`task_complete` 照常工作。
2. **渐进增强**：`/goal` 是可选的自主模式，不影响普通对话体验。
3. **关注点分离**：Agent loop、Goal loop、Stop hooks 各司其职，通过接口通信。
4. **借鉴成熟设计**：`needs_follow_up` 借鉴 Codex，验证循环借鉴 maka-agent，stop hooks 借鉴 Codex。
5. **先实现后写文档**：所有代码已存在于 working tree 中，文档描述实际架构。
