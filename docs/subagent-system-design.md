# 子智能体调度设计

日期: 2026-09-17 | 状态: 已实现

---

## 概述

主 Agent 通过 `subagent` 工具把任务委托给**专用子 Agent**。子 Agent 不是操作系统进程，而是主 worker 线程内的**逻辑沙箱**——新建一份消息数组、套一个专用 system prompt、限定工具白名单，然后跑同一个 `runAgentLoop`。

相对 fork 进程（~300ms 启动），逻辑沙箱把启动成本压到 ~30ms 量级，代价是共享同一线程（因此必须靠工具白名单与深度守卫来约束副作用）。

**核心原则：**

- **上下文隔离**：子 Agent 默认只看自己构造的 `messages[]`，不继承父对话
- **工具白名单**：子 Agent 只能调用定义里声明的工具
- **有界并发**：一次 dispatch 按 CPU 核数分批并行
- **预算封顶**：轮数 / 墙钟 / 输入 token / 工具调用数四重上限
- **摘要回流**：全文归档，父上下文只进精简摘要

---

## 定义来源

定义在 Agent 初始化时加载（`loadAgentDefinitions`），同名时**项目覆盖用户**：

| 优先级 | 目录 |
|---|---|
| 低 | `{homeDir}/.suncode/agents/*.md` |
| 高 | `{workingDir}/.suncode/agents/*.md` |

若两处都没有找到任何定义，回退到内置三件套 `getDefaultDefinitions()`：

| 名称 | 定位 | 工具白名单 | 默认 maxTurns |
|---|---|---|---|
| `explore` | 代码库探索（只读） | read, grep, glob | 8 |
| `review` | 代码审查（只读） | read, grep, glob, bash | 12 |
| `implement` | 代码实现（可写） | read, write, edit, bash, grep, glob | 20 |

文件形态为带 YAML frontmatter 的 Markdown（`parseAgentMarkdown`）：

~~~
---
name: explore
description: 代码库探索专家
tools: read, grep, glob
model: <可选>
thinking: <可选>
maxTurns: 8
---

<system prompt 正文>
~~~

`name` 与 `description` 为必填；`tools` 缺省为 `['read', 'bash', 'edit', 'write']`；正文作为该子 Agent 的 `systemPrompt`。

---

## 调用形态

工具名固定为 `subagent`（`src/worker/tools/subagent.ts`），支持两种等价写法：

~~~typescript
// 单调用
{ agent: "explore", prompt: "..." }
// 并行
{ calls: [{ agent: "explore", prompt: "..." }, { agent: "review", prompt: "..." }] }
~~~

单调用会被自动包装成 `calls[0]`，两种形态行为完全一致。

---

## 隔离模型

`runSubagent` 构造子 Agent 的消息数组：

1. **system**：`buildSystemPrompt(...)` 的标准结果 + 一段 `## 你的角色` 追加（子 Agent 的 `systemPrompt`）
2. **父上下文种子**：当 `initialContext === 'parent'` 时，把父对话的非 system 消息拷入，并以一句分隔语收尾
3. **命名会话历史**：当带 `session` 句柄时，追加 `namedSessions` 里该句柄的历史（键为 父 session + agent + handle）
4. **任务 prompt**：最后压入本次 `call.prompt`

命名会话保存在内存 Map（`namedSessions`），上限 `MAX_NAMED_SESSIONS = 50`，用于让同一 handle 的多轮委托共享上下文。

---

## 并发与预算

`dispatch(calls)` 分批执行，批大小 `cap = max(1, min(4, cpus().length - 1))`，批内 `Promise.all` 并行。

`SUBAGENT_BUDGET`（`subagent-budget.ts`）为硬上限：

| 维度 | 上限 | 触发行为 |
|---|---|---|
| 轮数 | 8（`resolveSubagentMaxTurns` 夹取 1..8） | 轮尽即停，标记 `partial` |
| 墙钟 | 60s | abort，标记 `partial` |
| 输入 token | 100k | abort，标记 `partial` |
| 工具调用 | 200 | abort，标记 `partial` |

另有**思考等级降级**：`resolveSubagentThinkingLevel` 把继承自父级的 `high` / `xhigh` 一律降到 `medium`，避免子 Agent 把预算烧在思考上。

预算或轮次触顶时，子 Agent 不静默失败，而是返回 `status: 'partial'` 并把已完成的工具调用压成 `partialProgress` 摘要回传父级。

---

## 守卫

| 守卫 | 规则 | 失败返回 |
|---|---|---|
| 深度 | `depth >= MAX_DEPTH(3)` 不再委托 | 错误：已达最大委托深度 |
| 环检测 | `call.agent` 已出现在 `ancestorStack` | 错误：检测到循环委托（并打印委托链） |
| 命名会话 | 达到 `MAX_NAMED_SESSIONS = 50` 且到来新键 | FIFO 淘汰最旧会话 |

子 Agent 的 abort 信号与父信号级联：父 run 被中断时，所有在跑的子 Agent 一并中断。

---

## 输出回传

子 Agent 的最终文本**全文归档**（`archiveToolResultBody` → `.suncode/tool-result-archive/`），父上下文只进一段摘要：

- 正常输出：保留前 `SUBAGENT_OUTPUT_SUMMARY_CHARS = 600` 字符，超出部分追加"完整输出已保存到 <path>，需要细节时用 read 读取"
- 错误输出：`SUBAGENT_ERROR_SUMMARY_CHARS = 300`

`SubagentResult` 同时带上 `toolCalls`、`tokenUsage`、`thinking`、`internalCalls`、`fullOutputPath`，并挂到父级的工具结果上（`subagentResults`）供 UI 渲染。

---

## 事件与 UI

子 Agent 的生命周期通过回调冒泡到 Worker → Renderer：

| 事件 | 时机 |
|---|---|
| `onSubagentStart` / `subagentStart` | 派发时（携带 `SubagentExecution`） |
| `onSubagentProgress` / `subagentProgress` | 子 Agent 的工具开始/结束（`tool_start` / `tool_end`） |
| `onSubagentEnd` / `subagentEnd` | 结束时（携带 `SubagentResult`） |

子 Agent 的 run 事件被转发到父 run 日志（独立 `runId`，写同一 session 下的独立 JSONL）。子 Agent 的工具进度（`onToolProgress`）**不**向上冒泡，避免噪音。

---

## 关键约束

1. **逻辑沙箱** — 同线程内数据级隔离，非 OS 进程隔离
2. **白名单强制** — 子 Agent 无法调用定义外的工具
3. **四重预算** — 轮数/墙钟/token/工具调用，任一触顶即 `partial`
4. **深度与环** — 最多 3 层，禁止环委托
5. **摘要回流** — 父上下文只进 ~600 字符，全文走归档 + `read`

---

## 相关源码

| 模块 | 路径 |
|---|---|
| 调度器 | `src/worker/agent/subagent.ts`（`SubagentDispatcher`） |
| 预算与降级 | `src/worker/agent/subagent-budget.ts` |
| 工具入口 | `src/worker/tools/subagent.ts`（`createSubagentTool`） |
| 定义加载 / 内置定义 | `src/worker/agent/agent.ts`（`loadAgentDefinitions` / `getDefaultDefinitions`） |
| 归档 | `src/worker/agent/tool-result-archive.ts` |
| 类型 | `src/shared/types.ts`（`SubagentDefinition` / `SubagentResult` / `SubagentExecution`） |
| 测试 | `src/worker/tools/subagent.test.ts` / `test/tools/subagent.test.ts` |
