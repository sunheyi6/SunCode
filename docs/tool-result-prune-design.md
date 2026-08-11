# 工具结果裁剪设计

日期: 2026-08-11 | 状态: 已实现

---

## 概述

工具结果裁剪（Tool Result Prune）是 agent 上下文管理中的**无损层**：超过阈值的大工具结果在进入下一次模型请求前，先完整归档到磁盘（content-addressed、可校验），再替换为约 80 token 的占位符。模型按需通过 `read` 工具读回原文。

**核心原则：**

- **Archive-before-omit**：先归档再裁剪；归档失败则保留原文（fail-open），绝不静默丢弃信息
- **无损可恢复**：被裁剪的内容一分不差地保存在磁盘，模型可随时取回
- **step 级处理**：每个模型迭代（turn）完成后统一判定，覆盖所有轮次
- **防自我循环**：已是占位符的不重复裁剪；模型读回归档的结果不再裁剪

与上下文压缩（Turn Cap / History Compact）是**两个职责域**：裁剪管"单条巨物"（无损、按需恢复），预算层管"整体历史"（有损、容量兜底），互不替代。上下文压缩见 [context-compaction-design.md](context-compaction-design.md)。

---

## 处理时机

`prepareNextTurn`（`agent-loop.ts`）在每个模型迭代（turn）完成后、下一次 LLM 调用前调用 `applyContextBudget`，其中 Layer 0 即工具裁剪：

```typescript
while (turnCount < loopTurnLimit) {
  turnCount++;
  // LLM 调用 → 执行工具 → 工具结果进上下文
  if (prepareNextTurn && !semanticProjectionApplied) {
    prepareNextTurn({ contextMessages, turnCount, … });  // → applyContextBudget
  }
}
```

**为什么 step 级处理即可覆盖所有轮次**：工具结果只在下一次模型请求时被消费（模型一次响应返回一批 tool calls，全部执行完统一发回，中间没有模型调用点）。`prepareNextTurn` 位于"结果进上下文 → 下一次请求"之间，因此在消费前统一判定即覆盖全部历史结果——不存在"最新轮/历史轮"的区别。

总开关：`settings.autoCompact`（默认 true），关闭后整个 pipeline 不运行。

---

## 判定规则

统一入口 `pruneToolResults`（`context-budget.ts`），对每条 `role === 'tool'` 消息依次过滤：

```
工具结果要进入模型请求前：
  1. 已是占位符？          → 跳过（isPlaceholderString，不重复裁剪）
  2. recovery read？       → 跳过（模型正在读归档，读回内容不再剪，防死循环）
  3. token > maxResultTokens（默认 2048）？ → 归档 + 占位符
  4. 否则                  → 保留原文
```

token 估算用字符数 / 4（`countStringTokens`），O(1)、不调 tokenizer。

**两条保护规则**（防系统自我循环）：

1. **占位符防重复**：`isPlaceholderString` 检测 `kind === 'suncode.archived_tool_result'`，已归档的消息不再裁剪。
2. **recovery 防死循环**：`toolCallTargetsArchiveDir` 检查工具调用的 JSON 参数是否引用归档目录（模型在 `read`/`cat` 归档文件）——这类调用的结果即使超阈值也不剪。否则"归档 → 读回 → 再归档读回的（因格式化往往更大）→ 再读"永远收敛不了。

---

## 归档机制（Archive-before-omit）

归档由独立模块 `tool-result-archive.ts` 执行：

1. 计算工具结果全文的 SHA-256（`bodySha256`）；
2. 生成 content-addressed 的 `artifactId = safeToolCallId_bodySha256[:32]`；
3. 写入 `${archiveDir}/${artifactId}.txt`；
4. 如果同名文件已存在，校验 hash 和字节数是否一致——一致则幂等返回，不一致则拒绝覆写并返回 `undefined`；
5. 返回 `ToolResultArchiveRecord { artifactId, bodySha256, originalBytes, absolutePath }`。

**fail-open**：`archiveDir` 未设置或写盘失败时，`rewriteEligibleToolResults` 保留原始 provider-visible body（`archiveFailures += 1` 计入诊断）：

```typescript
if (!archived?.artifactId?.trim()) {
  archiveFailures += 1;
  return msg; // 保留原始 provider-visible body
}
```

归档目录：`{appData}/sessions/{sessionId}/.suncode/tool-result-archive/`（`getAgentDataSubdir`）。

---

## 占位符协议（Schema v1）

裁剪后的工具结果被替换为 JSON 字符串（`buildPlaceholder`）：

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

字段分组：

| 分组 | 字段 | 作用 |
|---|---|---|
| 标识/协议 | `kind` / `schemaVersion` / `rewriteVersion` | 机器识别占位符、版本演进 |
| 定位/寻址 | `toolCallId` / `toolName` / `turnId` | 对应哪次工具调用、哪一轮 |
| 内容寻址 | `artifactId` / `bodySha256` / `bodyHash` | 唯一标识归档文件、完整性校验 |
| 描述/统计 | `originalTokens` / `originalBytes` / `originalChars` | 原文体积，模型可评估读回成本 |
| 审计 | `reason` | 为什么被裁剪 |
| 定位 | `artifactPath` | 磁盘绝对路径，模型 `read` 的目标 |
| 指引 | `recoveryHint` | 行为指令（如何恢复、勿重跑副作用工具） |

`reason` 取值：

| reason | 来源 |
|---|---|
| `tool_result_pruned` | 工具裁剪统一取值 |
| `pruned_exceeds_budget` | @deprecated，旧占位符兼容 |

占位符约 80 tokens，替换后 token 节省量 = `max(0, originalTokens - 80)`。

**模型视角**：占位符是一份自描述的档案索引——从字段即可知道什么内容被省略（toolName）、多大（originalTokens）、为什么（reason）、去哪找回（artifactPath）、如何校验（bodySha256）。`recoveryHint` 明确指示："Use the read tool on that path if you need the omitted content. Do not re-run the bash tool if it may have side effects."（需要时 read 恢复；不要重跑可能有副作用的工具）。

---

## 模型恢复（recovery read）

**何时读回由模型自决**——典型场景：下一步需要被省略的细节（grep 命中行、错误堆栈、文件内容的精确片段）。不需要读是大多数情况（模型已基于完整结果做完一轮决策）。

读回结果会再次进入上下文，并受 recovery 保护不再裁剪。代价是"按需 read"的一次工具调用，换取上下文常驻体积的大幅下降。

---

## 与 TurnEvidence 联动

裁剪后，`collectArchiveLinksFromMessages` 从新生成的占位符中提取 `artifactId / bodySha256 / artifactPath`，调 `turnEvidence.linkArtifacts` 回写到对应证据信封——使 completion gate 能从证据链重放，且归档与结构化摘要（`TurnEvidenceEnvelope.summary`）通过同一套 ID 关联。

---

## 设计演进记录

工具裁剪经历了三次迭代（详见 [context-compaction-design.md](context-compaction-design.md) 的历史背景）。演进原则：**只删从未使用的灵活性，不删能力；行为零变化。**

### v1（引入）：Active + Stale 双入口

- `pruneActiveToolResults`：只处理最近 1 个 turn 的超大结果（`minTurnNumber` 门槛）
- `pruneStaleToolResults`：保护最近 `minRecentTurnsFull` 个 turn，处理更早的
- 两者共享 `rewriteEligibleToolResults`，仅 eligibility 不同

### v2：移除 Snip 与 Context Collapse

六层 pipeline 中与裁剪相关的两个未启用层被移除：

1. **Snip 违反 Archive-before-omit**：占位符是 `[Archived: tool_xxx — N chars]` 纯文本，不落盘、无恢复路径——全系统唯一"静默丢信息"的路径。
2. **Context Collapse 伪造 system 指令**：折叠摘要以 `role: 'system'` 注入，违反"不伪造 system 指令"原则。

两者从未被 `buildContextBudgetPolicy()` 接线、零测试覆盖，功能与 Stale/Compact 重叠。

### v3（当前）：合并为单一 `pruneToolResults`

**理由：**

1. **拆分不增加能力**：Active（剪最新轮）+ Stale（剪更早轮）合起来 = "所有 >2048 的结果都归档"。合并行为完全等价（测试验证）。
2. **`minTurnNumber` / `minRecentTurnsFull` 是历史包袱**：产品从未调过其他值。合并后配置面只有 `{ enabled, maxResultTokens }`。
3. **"保护最近轮不剪"与设计意图相悖**：裁剪是每 step 的预防机制，保护最新轮的大结果 = 它原样进入下一次请求，正是裁剪要防的事。
4. **处理时机本就是 step 级**：`prepareNextTurn` 每次模型迭代后运行，结果只在下一次请求时消费——消费前统一判定即覆盖所有轮次，不存在"最新轮/历史轮"区别。
5. **为什么不能只保留 Active**：Active 只处理最近 1 个 turn，历史轮次的超大结果永不回收，长任务上下文线性膨胀（20 轮 × 3K token ≈ 57K token 常驻）。完整语义必须覆盖所有轮次。

**代价（接受）**：失去理论上"只剪最新轮 / 保护最近 N 轮"的细粒度配置——两者从未启用且有害，属纸面能力。

---

## 关键约束

1. **裁剪阈值** — `maxResultTokens` 默认 2048 token（字符数 / 4 估算）
2. **占位符体积** — 约 80 tokens，节省量 = `max(0, originalTokens - 80)`
3. **硬不变量** — Archive-before-omit：先归档、失败保留原文；任何新增层不得破坏
4. **防循环** — 占位符不重复剪、recovery 读不剪
5. **职责边界** — 裁剪是无损层（按需恢复）；整体历史压缩（Turn Cap / Compact）是有损层，见上下文压缩文档

---

## 相关源码

| 模块 | 路径 |
|---|---|
| 裁剪入口与判定 | `src/worker/agent/context-budget.ts`（`pruneToolResults` / `rewriteEligibleToolResults`） |
| 归档（content-addressed，archive-before-omit） | `src/worker/agent/tool-result-archive.ts` |
| 占位符构建 | `src/worker/agent/context-budget.ts`（`buildPlaceholder`） |
| token 估算 | `src/worker/utils/token-counter.ts` |
| 触发点（prepareNextTurn） | `src/worker/agent/agent-loop.ts` / `src/worker/agent/agent.ts` |
| 策略默认值 | `src/shared/constants.ts` |
| 类型（策略/占位符/诊断/事件） | `src/shared/types.ts` |
| TurnEvidence 归档链接 | `src/worker/agent/turn-evidence.ts` |
| 测试 | `test/agent/context-budget.test.ts` / `test/agent/turn-evidence.test.ts` |
