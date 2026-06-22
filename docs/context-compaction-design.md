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

## 6. 实现流程

```
Agent Loop 每一轮结束后:

    │
    ▼
estimateTokens(allMessages)
    │
    ▼
tokens > contextWindow × 0.7 ?
    │
    ├── 否 → 继续
    │
    └── 是 → compactMessages(messages, contextWindow)
                │
                ▼
        1. 分离 System Messages (保留)
        2. 找出非 System 消息中的 Turns
        3. 如果 turns ≤ keepRecentTurns → 跳过压缩
        4. 旧 turns → summarizeTurns()
        5. 生成压缩后的 messages:
           [system...] + [摘要] + [recent turns...]
                │
                ▼
        替换 agent.messages
        日志: "Compacted 8 messages → 1 summary"
```

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
