# 上下文压缩设计

> 状态：已实现；主动语义压缩仍为实验功能，默认关闭。本文以运行时代码为准，最近更新涵盖 Active Tool Result Prune、Archive-before-omit 不变量和 TurnEvidence 集成。

## 1. 目标与边界

长任务的上下文问题不只是在接近 context window 时避免请求失败，还包括：

- 重复发送已经完成的工具轨迹，增加输入 token 与延迟；
- 中间历史过长，稀释模型对当前目标和下一步动作的注意力；
- 压缩请求本身可能破坏 provider prefix cache，抵消压缩收益；
- 摘要错误可能让任务基于过时或虚构状态继续执行。

SunCode 因此保留两条互补路径：

| 路径 | 目的 | 是否调用 LLM | 默认状态 |
|---|---|---:|---|
| 容量保护压缩（capacity compaction） | 防止历史无限增长，裁剪旧工具结果和旧 turn | 否 | `autoCompact=true` |
| 主动语义压缩（semantic compaction） | 将当前长任务的已完成轨迹替换为 continuation projection | 是 | `semanticCompactMode=off` |

两条路径不互相替代。主动语义压缩成功应用后，本轮跳过容量保护压缩；如果主动压缩未触发、失败或只运行在 shadow 模式，容量保护路径仍可继续执行。

## 2. 共同原则

1. **精确保留当前用户请求**：运行开始时最后一条 user message 是 `headAnchor`，projection 不能替代或改写它。
2. **只压缩已完成历史**：主动压缩发生在一次带工具调用的 turn 完成之后，不压缩尚未闭合的协议片段。
3. **System Prompt 和工具定义保持稳定**：它们既决定模型行为，也是 provider prefix cache 的组成部分。
4. **失败关闭（fail closed）**：输出不合法、超预算、发生工具调用或 provider 请求失败时，不替换原始上下文。
5. **可审计**：projection 带 coverage、digest 和 lineage，运行事件记录触发、成功、拒绝、token 与耗时。
6. **Archive-before-omit**：所有工具结果裁剪路径先写盘归档，归档失败则 fail-open 保留原文，绝不丢弃不可恢复的数据。占位符中携带 content-addressed artifactId 和 SHA-256，模型可通过 `read` 工具恢复完整内容。
7. **模型元数据必须准确**：阈值由 `contextWindow × ratio` 计算；自定义模型未声明 context window 时会回退到 128K。

## 3. 容量保护压缩

### 3.1 触发位置

`autoCompact=true` 时，Agent Loop 在中间 turn 完成后调用 `prepareNextTurn`。历史预算为：

```text
maxHistoryTokens = model.contextWindow × compactThreshold
```

默认 `compactThreshold=0.7`。

### 3.2 Pipeline

`applyContextBudget()` 支持六层由低到高的处理：

```text
原始 contextMessages
  → Layer 0   Snip：移除不再被引用的旧工具结果
  → Layer 0.5 Active Tool Result Prune：当前轮大工具结果先归档再替换为占位符
  → Layer 1   Stale Tool Result Prune：旧轮次超长工具结果先归档再替换为占位符
  → Layer 2   Context Collapse：对工具密集的旧 turn 做读取时投影
  → Layer 3   Token Budget Turn Cap：从新到旧按 token 预算保留完整 turn
  → Layer 4   History Compact：高水位时用规则式摘要折叠旧 turn
```

当前 `buildContextBudgetPolicy()` 实际启用的是 Active Tool Result Prune、Stale Tool Result Prune、Token Budget Turn Cap 和 History Compact。Snip 与 Context Collapse 的实现及默认策略已经存在，但尚未从当前设置构建函数传入，因此不应把它们当作线上已启用能力。

Active 与 Stale 两条裁剪路径共享同一个核心函数 `rewriteEligibleToolResults`，区别仅在于 eligibility 判断：Active 路径只作用于最近 1 个轮次，Stale 路径排除最近 `minRecentTurnsFull`（默认 1）个轮次。

### 3.3 保留与摘要

- system message 永远保留；
- 最近至少 2 个 turn 保留（Token Budget Turn Cap 和 History Compact 各自独立配置 `minRecentTurns` / `keepRecentTurns`）；
- Active Tool Result Prune 只作用于最近 1 个轮次，且要求 `turnCount >= minTurnNumber`（默认 1）；
- Stale Tool Result Prune 保护最近 `minRecentTurnsFull`（默认 1）个轮次的工具结果不被裁剪；
- 单个工具结果超过 `maxResultTokens`（默认 2048）时触发裁剪；
- History Compact 保留最近 3 个 turn；
- 规则式摘要使用 `role=user`、`contextKind=capacity_summary`，避免伪造新的 system 指令。

容量保护压缩不调用 provider，成本低、确定性强，但语义保真度低于 LLM projection，因此只承担容量兜底职责。

### 3.4 Archive-before-omit 不变量

Active 和 Stale 两条裁剪路径都遵守同一个不变量：**先归档，再裁剪；归档失败则保留原文**。

归档由独立模块 `tool-result-archive.ts` 执行：

1. 计算工具结果全文的 SHA-256（`bodySha256`）；
2. 生成 content-addressed 的 `artifactId = safeToolCallId_bodySha256[:32]`；
3. 写入 `${archiveDir}/${artifactId}.txt`；
4. 如果同名文件已存在，校验 hash 和字节数是否一致——一致则幂等返回，不一致则拒绝覆写并返回 `undefined`；
5. 返回 `ToolResultArchiveRecord { artifactId, bodySha256, originalBytes, absolutePath }`。

当 `archiveDir` 未设置或归档失败时，`rewriteEligibleToolResults` 走 **fail-open** 路径：

```typescript
if (!archived?.artifactId?.trim()) {
  archiveFailures += 1;
  return msg; // 保留原始 provider-visible body
}
```

这意味着没有配置归档目录或磁盘写入失败时，工具结果不会被裁剪，模型仍能看到完整内容。诊断输出中会分别统计 `activeArchiveFailures` 和 `staleArchiveFailures`。

### 3.5 占位符格式（Schema v1）

裁剪后的工具结果被替换为 JSON 字符串，结构如下：

```typescript
interface ArchivedToolResultPlaceholder {
  kind: 'suncode.archived_tool_result';
  schemaVersion: 1;
  toolCallId: string;
  toolName: string;
  artifactId: string;       // content-addressed ID
  bodySha256: string;        // 全长 SHA-256
  bodyHash: string;          // bodySha256 前 16 位（兼容旧读取者）
  originalTokens: number;
  originalBytes: number;
  originalChars: string;    // @deprecated，保留兼容
  reason: ToolResultPruneReason;
  rewriteVersion: 1;
  turnId?: string;
  artifactPath: string;      // 磁盘归档绝对路径
  recoveryHint: string;      // 指导模型用 read 工具恢复
}
```

`reason` 取值区分两条路径：

| reason | 来源 |
|---|---|
| `active_current_turn_tool_result_pruned_before_next_step` | Active Prune（Layer 0.5） |
| `stale_tool_result_pruned` | Stale Prune（Layer 1） |
| `pruned_exceeds_budget` | @deprecated，旧占位符兼容 |

占位符约 80 tokens，替换后 token 节省量 = `max(0, originalTokens - 80)`。已经是占位符的消息不会被重复裁剪（通过 `isPlaceholderString` 检测）。

### 3.6 TurnEvidence 集成

工具结果裁剪与 TurnEvidence 系统协同工作：

1. **证据投影**：每轮工具结果完成后，`projectToolResultsToEvidence` 将 `ToolResult[]` 投影为 `TurnEvidenceEnvelope[]`，包含来源标记（`source`）、可见性（`visibility`）、权威性（`authority`）和结构化摘要（`summary`）。
2. **证据持久化**：`TurnEvidenceBuffer` 可 seedFromStore，持久化到 `.suncode/turn-evidence/<sessionId>/<runId>.json`。
3. **归档链接**：Context Budget 压缩后，`collectArchiveLinksFromMessages` 从新生成的 placeholder 中提取 `artifactId / bodySha256 / artifactPath`，调 `turnEvidence.linkArtifacts` 回写到对应 evidence。
4. **System Prompt 注入**：`turnEvidence.formatPromptWindow()` 生成有界文本，注入 `buildStructuredSystemPrompt` 的 `context.turnEvidence` 字段，为模型提供来源可信的近期观测窗口。
5. **Completion Gate 消费**：`updateCompletionGateFromEvidence` 从 TurnEvidence 信封驱动完成门状态机（write/edit → materialChange，bash exit 0 → verification），替代了旧的 `updateCompletionGateFromTools`。`rebuildCompletionGateFromEvidence` 可重放全部历史证据重建 gate 状态。

TurnEvidence 不是官方任务正确性证明，而是 smoke-check 纪律门和 system prompt 上下文的输入源。

## 4. 主动语义压缩

### 4.1 模式

| 模式 | 行为 |
|---|---|
| `off` | 不选择候选，也不发送压缩请求 |
| `shadow` | 生成并验证 projection，只记录指标，不替换上下文 |
| `replace` | projection 验证通过后替换覆盖范围 |

### 4.2 触发条件

一次中间 turn 完成后，同时满足以下条件才生成候选：

```text
estimatedTokens(contextMessages) >= model.contextWindow × semanticCompactThreshold
estimatedTokens(newlyCompletedHistory) >= semanticCompactMinNewTokens
```

候选范围从以下边界中最靠后的一个位置之后开始：

- 精确的 `headAnchor`；
- 已有 `semantic_projection`；
- shadow 模式已经覆盖到的消息。

第一次压缩覆盖 `headAnchor` 之后本次已完成的 raw span；rolling compaction 只覆盖 previous projection 之后新完成的 raw span，并通过 `previousProjectionId` 形成 lineage。

## 5. A → B → C：缓存友好的请求结构

### 5.1 A：正常主模型请求

```text
system prompt
+ tools
+ prior replay
+ exact current-user head anchor
+ completed raw trajectory
```

### 5.2 B：压缩请求

B 是一次独立 provider call，但不再使用一套全新的“压缩专用 system prompt”。它复用 A 的 provider-visible 前缀，只在消息尾部追加一条结构化压缩请求：

```text
same system prompt as A
+ same tools as A
+ same context messages as A
+ suncode.semantic_compact_request
```

请求继续使用相同模型、`sessionId` 和 `cacheRetention=long`。这样 B 的前缀与 A 相同，具备复用 A prefix cache 的条件。

这里保留 tools 是有意设计：tool schema 通常也是缓存前缀的一部分，从 B 中移除会提前破坏 prefix。System Prompt 明确要求模型在 semantic compact 请求下只返回 JSON、不得继续任务或调用工具；如果模型仍产生 tool call，运行时拒绝 projection 并保留原始历史。

### 5.3 C：压缩后的下一次主模型请求

`replace` 成功后，下一次主请求为：

```text
same system prompt and tools
+ prior replay before the current task
+ exact current-user head anchor
+ accepted semantic projection
+ verbatim open tail, when present
```

当前实现只在已完成 turn 的边界执行压缩，因此正常情况下 open tail 为空；`applySemanticProjection()` 保留了 `openTail` 接口，供未来存在未闭合协议尾部的场景使用。

C 仍会在 raw trajectory 被 projection 替换的位置发生一次 prefix 变化。这是主动购买的 attention shaping 成本。该设计消除的是旧方案中 B 自身不复用 A 前缀造成的额外缓存破坏，不能也不试图消除 C 的必要变化。

## 6. Projection 协议

### 6.1 请求

`suncode.semantic_compact_request` 包含：

- `sourceStartIndex` / `sourceEndIndex`；
- `sourceDigest`；
- `previousProjectionId`；
- `preserveExactUserHead=true`；
- `summarizePriorReplay=false`；
- 完整 JSON Schema 和 `json_only_no_markdown` 输出要求。

### 6.2 输出状态

模型必须返回以下字段：

```typescript
interface SemanticProjectionState {
  objective: string;
  constraints: string[];
  completedWork: string[];
  currentState: string[];
  decisions: string[];
  failedApproaches: string[];
  unresolvedWork: string[];
  nextAction: string;
}
```

为兼容部分模型，数组字段返回单个字符串时会规范化为单元素数组；字段缺失、类型不兼容或无法解析为 JSON 时仍然拒绝。

### 6.3 Projection message

验证通过后生成 `role=user`、`contextKind=semantic_projection` 的运行时消息，包含：

- `projectionId`；
- `previousProjectionId`；
- `headDigest`；
- `sourceDigest`；
- continuation state。

它不是新的用户指令。System Prompt 要求模型把 projection 当作运行时 continuation state，并始终以精确保留的用户 head 为更高优先级。

## 7. 验证与拒绝策略

以下情况不会替换原始消息：

| 原因 | 行为 |
|---|---|
| `head_missing` | 不发送 B |
| `below_pressure` | 等待上下文继续增长 |
| `insufficient_new_history` | 等待更多已完成历史 |
| `semantic_compact_tool_call` | 拒绝模型输出 |
| `invalid_projection_output` | 拒绝格式或结构错误的 projection |
| `projection_over_budget` | 拒绝超过输出 token 上限的 projection |
| `request_failed:*` | 记录错误，保留 raw history |

拒绝后不删除任何原始消息。若 `autoCompact=true`，容量保护压缩仍可作为兜底继续运行。

## 8. 配置与模型元数据

当前默认值：

```json
{
  "autoCompact": true,
  "compactThreshold": 0.7,
  "semanticCompactMode": "off",
  "semanticCompactThreshold": 0.5,
  "semanticCompactMinNewTokens": 4096,
  "semanticCompactMaxOutputTokens": 4096
}
```

自定义模型必须显式配置真实 context window：

```json
{
  "id": "glm-5.2:cloud",
  "contextWindow": 1000000
}
```

缺少该字段时，Model Registry 和 Agent Loop 都回退到 128K。对于 `glm-5.2:cloud` 这会把百分比阈值计算错约 7.8 倍，导致压缩过早且频繁。

百分比阈值并不天然跨模型可迁移：3% 在 1M 模型上约为 30K，在 128K 模型上只有约 3.8K。产品化前应考虑增加绝对 token 下限或“绝对阈值 + 比例阈值”的组合策略。

## 9. GLM-5.2 1M A/B 验证

2026-07-15 使用 SunCode 自身的 Harbor adapter，在 Terminal-Bench 2.0 hard 任务 `fix-code-vulnerability` 上完成一次 paired run：

- 模型：Ollama 官方库 `glm-5.2:cloud`；
- 测试进程覆盖 `contextWindow=1_000_000`；
- baseline：`semanticCompactMode=off`；
- candidate：`replace`、阈值 3%、`minNewTokens=4096`、`maxOutputTokens=2048`；
- verifier 通过宿主机 `127.0.0.1:7897` 代理联网；
- 两组官方 reward 均为 1.0。

该比较复用了先前的 baseline 结果，并单独运行 1M metadata candidate，不是同一 Harbor job 内的随机交替重复。Baseline 的自定义模型 metadata 当时仍回退为 128K，但 semantic compaction 关闭，且容量保护没有达到触发水位；Ollama 实际服务的仍是同一个 `glm-5.2:cloud` 百万上下文模型。这个差异不改变本次已观察到的请求内容，但后续正式多任务实验应让两组都显式使用相同的 1M metadata。

| 指标 | Baseline | Candidate | 变化 |
|---|---:|---:|---:|
| Agent 执行时间 | 311.312 s | 225.809 s | -27.5% |
| 模型请求累计耗时 | 186.386 s | 95.083 s | -49.0% |
| Provider 请求数 | 28 | 33 | +17.9% |
| 总输入 token | 902,451 | 594,347 | -34.1% |
| 主请求输入 token | 902,451 | 552,444 | -38.8% |
| 总输出 token | 6,059 | 5,320 | -12.2% |
| 平均主请求输入 | 32,230 | 17,264 | -46.4% |
| Semantic compaction | 0 | 1 started / 1 applied / 0 rejected | 成功 |

该结果说明在这一次长任务中，projection 保持任务质量并降低了 provider-visible input 与模型耗时。但它仍只是单任务、单次重复的方向性证据，不能直接外推为所有模型的默认参数。

Ollama 的 OpenAI-compatible usage 在两组中都报告 `cacheReadTokens=0`，因此本次无法量化 provider 端真实 prefix cache 命中率。能够确认的是 B 的请求结构已经满足前缀复用条件，以及 C 之后主请求输入确实下降。

当前设置 UI 的语义压缩阈值范围是 30%–90%；本次 3% 参数由 A/B settings patch 注入，只是实验配置，不是已发布默认值。

## 10. 可观测性与 A/B 方法

运行事件：

- `model_request_started/completed`，通过 `requestKind=main | semantic_compact` 区分；
- `semantic_compact_started`；
- `semantic_compact_completed`；
- `semantic_compact_rejected`；
- `context_budget_applied`：每次容量保护压缩实际修改消息时发射，包含 `activePrunedToolResults / activeEstimatedTokensSaved / activeArchiveFailures / prunedToolResults / prunedTokensSaved / staleArchiveFailures / beforeTokens / afterTokens`；
- `turn_evidence_recorded`：每轮工具结果投影为 TurnEvidence 后发射，包含 `turnId / count / evidenceIds`。

Harbor 结果 metadata 汇总：

- `semanticCompactStarted`；
- `semanticCompactCompleted`；
- `semanticCompactApplied`；
- `semanticCompactRejected`。

A/B 必须使用 SunCode-vs-SunCode：相同任务、模型、adapter、权限和 verifier，只通过 `SUNCODE_SETTINGS_PATCH_B64` 改变功能设置。比较时至少分开记录：

1. 官方 reward / verifier 质量；
2. main 与 compactor 的请求数、输入输出 token；
3. Agent execution 时间和模型请求累计时间；
4. compaction started/applied/rejected；
5. provider cache read/write（仅在 provider 实际上报时使用）。

Verifier 下载依赖的时间属于基础设施噪声，不应混入模型性能结论。

## 11. 相关源码

| 模块 | 路径 |
|---|---|
| 主动语义候选、协议、projection 验证 | `src/worker/agent/semantic-compact.ts` |
| A/B/C 请求编排与事件 | `src/worker/agent/agent-loop.ts` |
| 容量保护 pipeline（六层） | `src/worker/agent/context-budget.ts` |
| 工具结果归档（content-addressed，archive-before-omit） | `src/worker/agent/tool-result-archive.ts` |
| TurnEvidence 投影、buffer 与归档链接 | `src/worker/agent/turn-evidence.ts` |
| TurnEvidence 持久化路径解析 | `src/worker/agent/turn-evidence-store.ts` |
| Completion Gate（从 TurnEvidence 驱动） | `src/worker/agent/completion-gate.ts` |
| 规则式 history summary | `src/worker/agent/compaction.ts` |
| 压缩协议 System Prompt | `src/worker/agent/system-prompt.ts` |
| Structured system prompt（含 turnEvidence 注入） | `src/worker/agent/model-structured-content.ts` |
| 默认设置与容量策略 | `src/shared/constants.ts` |
| 设置、事件和 projection 类型 | `src/shared/types.ts` |
| A/B runner | `scripts/run-terminal-bench-ab.ts` |
| Settings patch 校验 | `scripts/terminal-bench-settings.ts` |
| Terminal-Bench runner | `scripts/run-terminal-bench.ts` |
