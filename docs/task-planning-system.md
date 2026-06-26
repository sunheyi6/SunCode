# 任务规划系统 — 设计文档

## 1. 设计目标

SunCode 需要模型在执行复杂任务前**先列计划、再按步骤执行**，而不是直接写代码。纯 system prompt 指导无法可靠约束模型行为，需要在 agent loop 层面强制执行。

核心需求：
- 执行类任务自动分类并输出结构化计划
- 计划步骤在 UI 中可视化展示（右侧面板）
- 每步完成后自动更新进度（打勾）
- **计划未全部完成时禁止终止对话**

## 2. 整体架构

```
用户发送消息
    │
    ▼
agent-loop.ts: 用户消息注入（主防线）
    │  将规划指令直接注入用户消息开头
    │  → 模型不可能跳过，因为指令在它要回复的消息里
    ▼
模型响应
    │
    ├── 正文包含 📋 → 解析器提取 TaskPlan
    │   └──→ chat store: ChatMessage.taskPlan
    │       └──→ GitPanel.vue: 右侧面板展示步骤清单
    │       └──→ TaskPlanCard.vue: 聊天框展示（已移除，避免重复）
    │
    ├── 模型调了工具 → 继续执行
    │
    └── 模型自然停止（无工具调用）→ Plan Gate 检查
        ├── 无计划 → 正常终止 ✅
        ├── 有计划 + 全部 [x] → 正常终止 ✅
        └── 有计划 + 有 [ ] → 强制继续（最多 3 次），超出后断路器触发
```

## 3. 三道防线

### 3.1 第一防线（主）：用户消息注入

**位置**：`src/worker/agent/agent-loop.ts`，主循环开始前

当对话中最后一条消息是用户消息时（新消息或跟进消息），将规划指令直接注入到该消息的文本开头：

```
在调用任何工具之前，你必须先在正文中完成以下步骤：
1. 分类：在正文开头标注 [查询] 或 [执行]
2. 如果是 [执行]，输出结构化计划：
📋 执行计划：
- [ ] Step 1: <具体行动>
- [ ] Step 2: <具体行动>
...
---
用户消息：${原始消息}
```

**关键设计**：`---` 分隔线后面拼接原始用户消息。UI 中显示的仍是原始消息（chat store 单独存储），不影响用户体验。

**排除条件**：合成提醒消息（如 "请调用 task_complete"、"你跳过了规划步骤"）不会再次注入，防止无限循环。

### 3.2 第二防线（备）：System Prompt 强化

**位置**：`src/worker/agent/system-prompt.ts`，动态部分的末尾

```
⚠️  PLANNING GATE — DO NOT SKIP ⚠️
Every response MUST start with a task classification in the text field:
  [查询] — for read-only questions
  [执行] — for tasks that modify code, run commands, or produce deliverables
If [执行], your text field MUST also include a plan BEFORE calling tools
```

作为第一防线的兜底，在 system prompt 末尾用醒目格式强调。

### 3.3 第三防线（兜底）：首轮工具调用后检查

**位置**：`src/worker/agent/agent-loop.ts`，首轮工具执行完毕后

如果 turn 1 或 turn 2 的模型中使用了非只读工具（write, edit, bash, subagent）但没有输出 `📋` 标记 → 注入提醒消息：

```
你跳过了规划步骤。请立即在正文开头输出 [执行] 分类标记和 📋 执行计划。
```

## 4. Plan Gate：计划完成度强制检查

### 4.1 自然停止拦截

模型不再调用工具（`turnDecision.decision === 'stop', reason: 'no_follow_up'`）时，统一在此处检查计划：

```typescript
// agent-loop.ts: stop 分支
const planCheck = checkPlanCompletion(assistantText);
if (planCheck.hasPlan && planCheck.pendingCount > 0 && planForceContinueCount < 3) {
  planForceContinueCount++;
  // 列出未完成步骤，强制继续
  contextMessages.push({
    role: 'user',
    content: `你的执行计划还有 ${pendingCount} 个步骤未完成。请继续执行：
  - [ ] Step 2: 修改代码
  - [ ] Step 3: 运行测试`
  });
  continue;
}
```

### 4.2 断路器

防止死循环：`planForceContinueCount` 超过 3 次后接受终止。

```
模型自然停止 → Plan Gate 拦截 → 最多 3 次 → 断路器触发，接受
```

### 4.3 task_complete（可选）

模型可以显式调 `task_complete` 来加速结束，但不强制要求。调了也会走相同的 Plan Gate 检查。

### 4.4 设计选择：不再强制要求 task_complete

之前要求模型必须调 `task_complete` 才能终止，但 DeepSeek 等推理模型经常忘记调，导致对话进入"提醒→继续→提醒→继续"循环。改为"不调工具 = 完成"（Codex 设计），Plan Gate 是唯一的安全网。

## 5. Plan Parser

**文件**：`src/renderer/utils/task-plan-parser.ts`

### 5.1 解析逻辑

从模型文本中提取结构化 `TaskPlan`：

```typescript
export function parseTaskPlan(content: string, isStreaming: boolean): TaskPlan | null
```

**步骤**：
1. 检查 `📋` 标记存在
2. 找到最后一个 `📋 执行计划：` 或 `📋 进度更新：`（最新状态）
3. 用正则提取步骤行

**支持多种格式**（宽松解析）：

| 格式 | 示例 | 优先级 |
|------|------|--------|
| 标准格式 | `- [ ] Step 1: 分析代码` | 优先 |
| 数字编号 | `- [ ] 1. 分析代码` | 回退 |
| 中文编号 | `- [ ] 第一步：分析代码` | 回退 |
| 无编号 | `- [ ] 分析代码` | 自动编号 |

**流式处理**：`isStreaming=true` 时，如果已有步骤标记为 done，将第一个 pending 步骤标为 `in_progress`（驱动右侧面板呼吸灯）。

### 5.2 去重函数

```typescript
export function stripPlanFromContent(content: string): string
```

从文本中移除计划块，避免在 markdown 渲染中重复显示（计划已在右侧面板展示）。

## 6. 数据流

### 6.1 类型定义

```typescript
// src/shared/types.ts
export type TaskType = 'query' | 'execution'
export type StepStatus = 'pending' | 'in_progress' | 'done'

export interface TaskStep {
  id: string        // "step_1"
  index: number     // 1-based
  description: string
  status: StepStatus
  result?: string   // "已完成 — 找到3个文件"
}

export interface TaskPlan {
  taskType: TaskType
  steps: TaskStep[]
}
```

### 6.2 ChatMessage 扩展

```typescript
// src/renderer/stores/chat.ts
export interface ChatMessage {
  // ... 已有字段
  taskPlan?: TaskPlan;  // 从文本中解析的计划
}
```

### 6.3 解析时机

| 触发点 | 时机 | 参数 |
|--------|------|------|
| `handleStreamEvent: text_delta` | 每 30 字符或遇 `📋` 时 | `isStreaming = true` |
| `loadMessages` | 从持久化恢复消息时 | `isStreaming = false` |
| 解析完成后 | `stripPlanFromContent` 去重 | — |

## 7. UI 设计

### 7.1 右侧悬浮面板（GitPanel.vue 统一面板）

**显示条件**：有 git 仓库 **或** 有计划数据

**三个区域**：

| 区域 | 显示条件 | 内容 | 折叠 |
|------|----------|------|------|
| 📋 执行计划 | `chatStore` 中有 plan | 步骤清单（○/◉/✓）+ 进度 + 执行时间 | 默认 5 条，点"展开全部" |
| Git 工具 | 工作目录是 git 仓库 | 分支、更改行数、提交入口 | 不需折叠 |
| 进程 | 有后台任务 | 命令名 + 状态 + 运行时间 | 不需折叠 |

**Pill 按钮**：折叠时显示一行摘要（如 `📋 计划 2/4 · ⑂ main`），点击展开卡片。

**执行时间**：计划开始后实时计时（`⏱ 2m15s`），完成时定格。

### 7.2 聊天框

计划**仅**在右侧面板显示，聊天框中不重复（TaskPlanCard 已移除）。

### 7.3 步骤状态图标

| 状态 | 图标 | 动画 | 颜色 |
|------|------|------|------|
| pending | ○ | 无 | 灰色半透明 |
| in_progress | ◉ | 脉冲 | 主题色（蓝） |
| done | ✓ | 无 | 绿色，文字删除线 |

## 8. 关键实现文件

| 文件 | 职责 |
|------|------|
| `src/worker/agent/agent-loop.ts` | 用户消息注入、Plan Gate（task_complete 拦截）、提醒上限拦截、断路器、checkPlanCompletion |
| `src/worker/agent/system-prompt.ts` | ⚠️ PLANNING GATE 醒目格式 |
| `src/shared/constants.ts` | DEFAULT_SYSTEM_PROMPT 中的计划格式规范 |
| `src/shared/types.ts` | TaskType、StepStatus、TaskStep、TaskPlan 类型 |
| `src/renderer/utils/task-plan-parser.ts` | parseTaskPlan()、stripPlanFromContent() |
| `src/renderer/stores/chat.ts` | ChatMessage.taskPlan 字段、流式解析、加载时解析 |
| `src/renderer/components/layout/GitPanel.vue` | 右侧统一面板：Plan + Git + Process |

## 9. 设计取舍

**为什么不用新工具（task_plan）？**
- 解析文本中的 checklist 标记更轻量，无需 worker ↔ renderer 额外通信
- 文本是模型的原生输出格式，不会被遗忘或跳过
- 兼容所有模型，不依赖工具调用机制

**为什么注入到用户消息而非 system prompt？**
- system prompt 太长，模型容易走马观花
- 注入到用户消息开头 = 模型回复前最后读到的东西，不可能忽略
- 类似 Claude Code 的 "synthetic user message" 模式

**为什么需要断路器？**
- 模型可能陷入"声称完成但不调 task_complete → 被强制继续 → 再次声称完成"的死循环
- 断路器确保对话不会无限循环，用户不需要手动 abort

**为什么计划只在右侧面板显示？**
- 聊天框已有正文内容，再加计划卡片导致信息过载
- 右侧面板是"进度仪表盘"，看一眼就知道执行到哪了
- 减少文本框的视觉噪音

## 10. 经验教训

### 10.1 DeepSeek 推理模型倾向
推理模型天然把分析输出到 thinking 字段，text 字段极短。即使注入规划指令，模型也可能在 thinking 中规划而不在 text 中输出。这导致：
- plan 解析器找不到 `📋` 标记 → TaskPlanCard 不渲染
- Plan Gate 不触发 → 对话提前终止

**缓解**：第三防线（首轮后检查）检测到 text 中无 `📋` 且使用了工具时，注入强提醒。

### 10.2 多次提醒后模型仍不完成计划
模型可能因上下文过长、任务过于复杂、或不知道如何完成剩余步骤，而反复走"提醒→声称完成→被拦截→再提醒"循环。

**缓解**：断路器机制 + 列出具体未完成步骤名称，帮助模型定位。

### 10.3 构建错误死循环
编辑 agent-loop.ts 时容易因括号匹配错误导致 esbuild 构建失败。Worker 进程无法启动，应用直接打不开。

**缓解**：修改后立即运行 `vue-tsc --noEmit` 验证，发现错误立即修复。
