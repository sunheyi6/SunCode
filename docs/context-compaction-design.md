# 上下文压缩设计文档

## 1. 问题背景

Coding agent 的每次请求都需要将**完整对话历史**发送给 LLM。随着对话增长：

- 对话历史很快超过模型的 context window（如 128K tokens）
- 即使不超限，长上下文也会导致：响应变慢、费用增加、模型注意力分散

**上下文压缩（Context Compaction）** 是解决这个问题的核心机制。

---

## 2. 设计目标

- **透明**：对用户无感知，自动触发
- **保真**：压缩后不丢失关键信息（已做的修改、重要的发现）
- **可控**：用户可以手动触发，可配置触发阈值
- **渐进**：不是一次性删掉历史，而是逐步替换为摘要

---

## 3. 压缩策略

### 3.1 触发条件

```
estimatedTokens(allMessages) > model.contextWindow × compactThreshold
```

默认 `compactThreshold = 0.7`，即使用到 70% 上下文窗口时触发。

### 3.2 保留策略

```
┌────────────────────────────────────────────┐
│  System Prompt (永远保留)                   │  ← 角色 + 工具 + 环境
├────────────────────────────────────────────┤
│  [压缩摘要]                                 │  ← 早期轮次的总结
│  "User asked about X. Assistant did Y..."  │
├────────────────────────────────────────────┤
│  Turn N-2 (完整保留)                        │  ← 最近 3 轮
│  Turn N-1 (完整保留)                        │
│  Turn N   (完整保留，最当前)                 │
└────────────────────────────────────────────┘
```

**为什么保留最近 3 轮？**

- 最近轮次有"上下文局部性"——当前操作大概率引用最近的对话
- 3 轮是一个经验值：够用但不浪费空间
- 可配置：`keepRecentTurns` 参数允许调整

### 3.3 压缩粒度：以 Turn 为单位

一个 "Turn" = 一个用户消息 + 该消息触发的所有 assistant/tool 消息：

```
Turn:
  User: "fix the login bug"
  Assistant: "Let me read auth.ts"  → tool_call: read
  Tool Result: (file contents)
  Assistant: "I found the issue..." → tool_call: edit
  Tool Result: (edit success)
  Assistant: "Fixed! The issue was..."
```

压缩时整个 Turn 被替换为一条摘要消息。

---

## 4. 摘要生成

### 4.1 当前方案：规则式摘要

V1 使用简单的启发式规则生成摘要，不依赖 LLM：

```typescript
function summarizeTurns(turns: Message[][]): string {
  for (const turn of turns) {
    const userMsg = turn.find(m => m.role === 'user');
    
    // 用户消息：截取前 100 字符
    "User asked: 'fix the login bug in auth...'"
    
    // Assistant 消息：计数工具调用 + 截取响应
    "  Assistant: Used 2 tool(s). Found the issue in..."
  }
}
```

**优点**：
- 速度快，不消耗额外 token
- 确定性，不会引入 LLM 幻觉

**缺点**：
- 摘要质量一般，丢失细粒度信息
- 无法识别关键决策点

### 4.2 V2 方案（计划）：LLM 驱动摘要

使用 cheap model（如 gpt-4.1-nano 或 claude-haiku）对历史轮次做专门摘要：

```
SYSTEM: Summarize this conversation. Keep:
  1. What the user asked
  2. What changes were made (file paths + what changed)
  3. Any important discoveries or decisions
  4. What still needs to be done

USER: [旧轮次的完整对话]
```

**优点**：
- 摘要质量高，保留关键决策路径
- 可结构化输出（JSON Schema）

**缺点**：
- 需要额外 API 调用
- 有延迟和费用

---

## 5. Token 估算

### 5.1 字符启发式

```typescript
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

**为什么用字符数 / 4？**

- 英文中 1 token ≈ 4 字符（经验值）
- 不需要加载 tiktoken（减少 3MB 依赖）
- 对于压缩触发判断，±20% 的误差可以接受

### 5.2 精确计算（V2 方案）

使用 `@anthropic-ai/tokenizer` 或 `tiktoken` 做精确计数：

| 语言 | chars/token | 用 /4 的误差 |
|------|------------|------------|
| 英文 | 4.0 | 基准 |
| 中文 | ~1.5 | 低估 2.7x |
| 代码 | ~3.5 | 高估 14% |
| 混合 | ~3.0 | 高估 33% |

中英文混合场景下字符启发式误差较大，V2 应引入精确 tokenizer。

---

## 6. 实现流程 (v2026-06 已实现)

压缩通过 `prepareNextTurn` 钩子集成到 Agent Loop 中：

```
Agent Loop 每轮结束后 (turn_end 发送后):

    │
    ▼
prepareNextTurn(ctx) 被调用 (如果 autoCompact 开启)
    │
    ▼
ctx.contextMessages.length > compactThreshold × 100 ?
    │
    ├── 否 → return undefined → 继续
    │
    └── 是 → 执行压缩:
        1. 找到 System Message（保留）
        2. 从非 System 消息中保留最近 50% (compactThreshold/2)
        3. 拼接: [system] + [recent half]
        4. 返回 { contextMessages: compacted }
                │
                ▼
        agent-loop.ts 用 compacted 替换 contextMessages
        日志: "[Agent] Context compacted: 42 → 21 messages"
```

**当前实现** (`src/worker/agent/agent.ts`):
```typescript
prepareNextTurn: this.settings.autoCompact
  ? (ctx) => {
      if (ctx.contextMessages.length <= compactThresholdMsgs) return;
      const systemMsg = ctx.contextMessages.find(m => m.role === 'system');
      const rest = ctx.contextMessages.filter(m => m.role !== 'system');
      const trimmed = rest.slice(-Math.floor(compactThresholdMsgs / 2));
      return { contextMessages: systemMsg ? [systemMsg, ...trimmed] : trimmed };
    }
  : undefined
```

**设计选择**：
- V1 使用消息数阈值而非精确 token 计数——简单、快速、对大多数场景足够
- `compactThreshold = 0.8` (默认)，即 ~80 条消息时触发，保留最近 ~40 条
- 不做 LLM 摘要——保留原始消息，只是截断旧的
- 通过 `prepareNextTurn` 钩子实现，符合 pi 项目的架构约定

---

## 7. 压缩效果

### 典型 session 压缩前后对比

```
压缩前 (15 turns, ~85K tokens):
┌──────────────────────────────────┐
│ System Prompt          ~3K       │
│ Turn 1-12 (完整)       ~70K      │
│ Turn 13 (完整)         ~5K       │
│ Turn 14 (完整)         ~4K       │
│ Turn 15 (完整)         ~3K       │
│ Total:                 ~85K      │
└──────────────────────────────────┘

压缩后 (keepRecentTurns=3, ~25K tokens):
┌──────────────────────────────────┐
│ System Prompt          ~3K       │
│ [摘要: Turns 1-12]     ~1K       │ ← 70K → 1K (98.6% 压缩)
│ Turn 13 (完整)         ~5K       │
│ Turn 14 (完整)         ~4K       │
│ Turn 15 (完整)         ~3K       │
│ Total:                 ~16K      │
└──────────────────────────────────┘
```

节省了 ~69K tokens，对于 Claude Opus ($15/M input) 约节省 $1。

---

## 8. 设计经验

### ✅ 有效实践

1. **保守触发**：70% 阈值留有 30% 余量给当前轮次的工具调用开销
2. **Turn 级别的摘要**：保持对话的语义边界，不会在中间截断
3. **System 消息永远不压缩**：角色定义和工具 Schema 丢失会导致模型行为异常
4. **压缩标记**：摘要消息添加 `[Previous conversation summary]` 前缀，让模型知道这是压缩过的

### ❌ 常见陷阱

1. **过早压缩**：阈值设太低（如 50%），模型可能丢失重要上下文
2. **丢失文件状态**：压缩掉关键的文件修改信息，模型后续操作基于过时假设
3. **摘要质量差**：只保留用户问题不保留 assistant 做了什么，模型不知道进度
4. **忘记压缩 token 也会累积**：摘要本身也占 token，无限循环压缩不会无限节省

### 📊 压缩触发频率

| 模型 | Context Window | 典型触发 Turn | 说明 |
|------|---------------|-------------|------|
| Claude Haiku | 200K | ~30 turns | 很少需要压缩 |
| GPT-5.1 Codex | 128K | ~20 turns | 中等频率 |
| Gemini Flash | 1M | ~150 turns | 几乎不需要 |

---

## 9. V2：Tool Result Prune（工具结果裁剪）— 2026-06 实现

### 9.1 动机

Maka Agent 的实践表明：对 tool result 做激进裁剪（超长结果 → 结构化占位符），推理质量几乎不变。原因有三：

1. **信息已被蒸馏进 Assistant Message**——每次 tool result 之后，模型都会输出 Assistant Message 表达理解和下一步决策，这是一次语义蒸馏
2. **Attention 在长上下文里本来就稀疏**——"Lost in the Middle" 证明模型更关注开头和最近几轮，中间段的 tool result 信息密度低
3. **决策点已经过去**——5 轮之后，旧 tool result 早已不是边际信息

SunCode 当前只有 V1 的消息数截断，缺少这一层"细粒度裁剪"。

### 9.2 三层压缩架构

```
原始 contextMessages
    │
    ▼
[1] Stale Tool Result Prune     ← 单条裁剪：超长 tool result → 占位符
    │
    ▼
[2] Token Budget Turn 截断       ← 按 token 预算保留最近 N 个 turn
    │
    ▼
[3] History Compact（高水位触发）  ← 折叠旧 turn → 摘要消息
    │
    ▼
压缩后的 contextMessages
```

### 9.3 第一层：Stale Tool Result Prune

**算法**：
1. 将消息按 turn 分组（turn = user message + 后续所有非 user message）
2. 保护最近 `minRecentTurnsFull`（默认 1）个 turn 的 tool result 不裁剪
3. 对保护窗口之外的每个 `role: 'tool'` 消息：
   - 估算 content 的 token 数
   - 如果 > `maxResultTokens`（默认 2048）→ 替换为占位符

**占位符格式**（~180 字符 / 45 tokens）：
```json
{
  "kind": "suncode.archived_tool_result",
  "toolCallId": "tc_abc123",
  "toolName": "bash",
  "bodyHash": "sha256-a1b2c3d4...",
  "originalTokens": 5230,
  "originalChars": 20918,
  "reason": "pruned_exceeds_budget"
}
```

**效果**：一条 5000 token 的工具返回被替换为 ~45 token 的占位符，节省 ~99%。

### 9.4 第二层：Token Budget Turn 截断

替代 V1 的"消息数阈值"，改为 token 预算控制：

1. 从最新 turn 往前累计 estimated tokens
2. 保护 `minRecentTurns`（默认 2）个 turn 一定保留
3. 超过 `maxHistoryTokens` 时停止保留更早的 turn
4. 可结合模型 context window 自动计算合理预算

### 9.5 第三层：History Compact（复用）

当裁剪+截断后仍然超过高水位（默认 80% context window），触发 turn 级别的折叠压缩。复用 V1 的 `compactMessages()` 函数，用规则式摘要替代旧 turn。

### 9.6 集成方式

通过 `prepareNextTurn` 钩子集成到 agent loop，每轮结束后自动调用：

```typescript
prepareNextTurn: (ctx) => {
  const policy = buildContextBudgetPolicy(settings, modelContextWindow);
  const result = applyContextBudget(ctx.contextMessages, policy);
  return { contextMessages: result.messages };
}
```

### 9.7 配置

```typescript
interface ContextBudgetPolicy {
  maxHistoryTokens?: number;       // 先验历史的最大 token 预算
  maxHistoryTurns?: number;        // 保留的最大 turn 数
  minRecentTurns?: number;         // 最小保留 turn 数（默认 2）
  charsPerToken?: number;          // token 估算比例（默认 4）
  staleToolResultPrune?: {
    enabled: boolean;              // 默认 true
    maxResultTokens?: number;      // 超过此值的 tool result 被替换（默认 2048）
    minRecentTurnsFull?: number;   // 最近 N 个 turn 的结果不裁剪（默认 1）
  };
  historyCompact?: {
    enabled: boolean;              // 默认 true
    highWaterRatio?: number;       // 触发阈值（默认 0.8）
    keepRecentTurns?: number;      // 压缩时保留的最近 turn 数（默认 3）
  };
}
```

### 9.8 设计决策

| 决策 | 取值 | 理由 |
|---|---|---|
| prune 阈值 | 2048 estimated tokens | 约 8000 字符，覆盖短结果；长的才裁剪 |
| 保护窗口 | 最近 1 个 turn | 模型正在"用"的信息不裁剪 |
| 占位符格式 | 结构化 JSON (~180 chars) | 保留元数据，为 V3 archive retrieval 留接口 |
| 不持久化存档 | V2 暂不做 | 先验证裁剪本身的效果 |
| 默认开启 | autoCompact=true 时自动启用 | 对用户透明 |
