# SunCode 设计文档

## 文档索引

| 文档 | 说明 |
|------|------|
| [系统提示词设计](system-prompt-design.md) | System Prompt 构建：角色定义、Tool Discipline 反循环规则、一行式工具摘要、XML 结构化上下文、Token 优化 |
| [工具调用设计](tool-calling-design.md) | 工具架构：回合事件 (turn_start/end)、参数验证、前端工具卡片 (Command/File/Inspect)、数据流 |
| [上下文压缩设计](context-compaction-design.md) | 通过 `prepareNextTurn` 钩子自动压缩：触发策略、消息保留、与 Agent Loop 集成 |
| [任务规划系统](task-planning-system.md) | 强制执行规划：三道防线、Plan Gate、Plan Parser、右侧面板统一、断路器机制 |
| [任务结束判断机制](task-completion-mechanism.md) | `needs_follow_up` 决策、Goal 自主循环、Stop Hooks、双字段输出模型 |

## 2026-06 架构变更摘要

| 变更 | 说明 |
|------|------|
| 多 Session 并发 Agent | Worker 内 `Map<string,Agent>` 替代单例，每 session 独立 Agent 实例并行运行，消息按 sessionId 路由 |
| Session 切换 abort | 切换 session 时先 abort 当前 run，避免 `setMessages` 被静默忽略导致消息丢失 |
| Token 实时追踪 | `onTurnStart` 回调传递实时 token 累计值，`emitStatus` 合并已提交 + 当前 run token，StatusBar 每轮刷新 |
| 后台进程多实例管理 | bgProcessStarted/bgProcessCompleted 事件，支持多 bash 后台进程独立追踪和 kill |
| Agent turn 计数 | Agent 全局 turnCount 跨 run 累计，StatusBar 显示当前轮次 |
| Tool Usage Discipline | 新增反循环规则章节，防止模型无限调用工具 |
| 工具一行式摘要 | 替代完整 JSON Schema，节省 ~60% 工具 token |
| `<project_context>` XML | 结构化注入 .agents.md / Skills，遵循 pi/Codex 约定 |
| `prepareNextTurn` 钩子 | 回合间上下文压缩 + 未来动态换模型的扩展点 |
| `turn_start` / `turn_end` 事件 | 回合边界感知，前端展示进度（第N轮）|
| 工具参数运行时验证 | 必填参数检查 + 类型强制转换 |
| 前端工具卡片优化 | FileInspectCard (read/glob/grep)、思考区自动折叠、输入历史导航 |
| 任务规划系统 | 三道防线（用户消息注入 + System Prompt + 首轮检查）、Plan Gate 强制步骤完成、断路器防死循环 |
| Plan Parser | 宽松解析模型输出中的 📋 checklist，支持多种编号格式，自动去重 |
| 右侧面板统一 | Git + Plan + Process 三合一右侧悬浮面板，计划 5 条默认折叠，显示执行时间 |

## 相关源码

| 模块 | 路径 |
|------|------|
| 系统提示词生成 | `src/worker/agent/system-prompt.ts` |
| Skills 加载器 | `src/worker/agent/skills.ts` |
| 上下文压缩 | `src/worker/agent/agent.ts` (`prepareNextTurn`) |
| Agent 循环 | `src/worker/agent/agent-loop.ts` |
| 工具注册中心 | `src/worker/tools/registry.ts` |
| 工具实现 | `src/worker/tools/*.ts` |
| 前端工具卡片 | `src/renderer/components/tools/*.vue` |
| 思考区组件 | `src/renderer/components/chat/AssistantMessage.vue` |
| 输入历史 | `src/renderer/components/chat/ChatInput.vue` |
| MCP 集成 | `src/worker/mcp/*.ts` |
