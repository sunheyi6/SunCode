# SunCode 设计文档

## 文档索引

| 文档 | 说明 |
|------|------|
| [系统提示词设计](system-prompt-design.md) | System Prompt 构建：角色定义、Tool Discipline 反循环规则、一行式工具摘要、XML 结构化上下文、Token 优化 |
| [工具调用设计](tool-calling-design.md) | 工具架构：回合事件 (turn_start/end)、参数验证、前端工具卡片 (Command/File/Inspect)、数据流 |
| [上下文压缩设计](context-compaction-design.md) | 通过 `prepareNextTurn` 钩子自动压缩：触发策略、消息保留、与 Agent Loop 集成 |
| [任务规划系统](task-planning-system.md) | 强制执行规划：三道防线、Plan Gate、Plan Parser、右侧面板统一、断路器机制 |
| [任务结束判断机制](task-completion-mechanism.md) | `needs_follow_up` 决策、Goal 自主循环、Stop Hooks、双字段输出模型 |
| [子智能体架构](subagent-architecture-comparison.md) | 子 Agent 委托系统：三框架对比 (pi-subagent/maka-agent/Codex CLI)、Dispatcher 调度、流式进度 |
| [运行事件日志](run-event-logging-design.md) | JSONL 持久化：run_started/run_completed/model_request/turn_detail、CallTracePanel 回溯、Token 用量统计 |
| [会话标题生成](session-title-generation.md) | AI 自动生成会话标题：轻量模型选取、TITLE_GENERATION_PROMPT、fallback 规则 |

## 2026-06～07 架构变更摘要

| 变更 | 说明 |
|------|------|
| **Dev/发版身份隔离** | `src/main/app-identity.ts` 作为主进程**最先 import** 的 bootstrap：dev 模式（`!app.isPackaged`）调用 `app.setName('SunCode Dev')`，使 dev 与发版 app 拥有独立的单实例锁 key 与 userData 目录（`%APPDATA%\SunCode Dev` vs `%APPDATA%\SunCode`）。避免 Windows 大小写不敏感导致 dev 与发版 app 共用锁、共用数据目录、互相"顶替"窗口。必须在任何 `app.getPath('userData')` 调用前执行，故独立成模块并置于 import 链首位 |
| **启动流程适配器** | `scripts/launch-dev.js` 统一接管 `dev` 命令：Bun 可用性探测 → 依赖完整性自动修复 → 无 TTY/CI 适配 → Electron 桌面会话检查 → 启动失败诊断 |
| 多 Session 并发 Agent | Worker 内 `Map<string,Agent>` 替代单例，每 session 独立 Agent 实例并行运行，消息按 sessionId 路由 |
| SessionLock 串行化 | `withSessionLock` Promise 链保证同一 session 的 prompt/continue 操作不并发竞态；**stop/abort 不使用锁**直接中断 |
| **软停止 (Soft Stop)** | 点击停止按钮 → `requestStop()` 设 flag + abort → 流中断 → 追加"请总结完成的操作" → 单轮纯文本总结 → 结束；区别于硬 abort |
| **自动滚动修复** | 内容变化时始终自动滚到底部（不再 gate 在 `isStreaming`），工具执行/子智能体进度等离线更新也能触发；仅用户手动上滚时暂停 |
| Session 切换 abort | 切换 session 时先 abort 当前 run，避免 `setMessages` 被静默忽略导致消息丢失 |
| Token 实时追踪 | `onTurnStart` 回调传递实时 token 累计值，`emitStatus` 合并已提交 + 当前 run token，StatusBar 每轮刷新 |
| 后台进程多实例管理 | bgProcessStarted/bgProcessCompleted 事件，支持多 bash 后台进程独立追踪和 kill；停止对话时自动清理 |
| Agent turn 计数 | Agent 全局 turnCount 跨 run 累计，StatusBar 显示当前轮次 |
| Tool Usage Discipline | 新增反循环规则章节，防止模型无限调用工具 |
| 工具一行式摘要 | 替代完整 JSON Schema，节省 ~60% 工具 token |
| `<project_context>` XML | 结构化注入 .agents.md / Skills / Memory / Lessons，遵循 pi/Codex 约定 |
| Skills 技能系统 | `~/.suncode/skills/` + 项目 `.suncode/skills/` 双层加载，Markdown 格式，注入 system prompt |
| Memory 记忆系统 | 每次 session 结束自动生成记忆摘要存入 `.suncode/memories/`，下次对话根据语义检索注入上下文 |
| Lessons 教训系统 | 失败时自动提取教训存入 `.suncode/lessons/`，后续相关任务检索注入，避免重复踩坑 |
| `prepareNextTurn` 钩子 | 回合间上下文压缩 + 未来动态换模型的扩展点 |
| `turn_start` / `turn_end` 事件 | 回合边界感知，前端展示进度（第N轮）|
| 工具参数运行时验证 | 必填参数检查 + 类型强制转换 |
| 前端工具卡片优化 | FileInspectCard (read/glob/grep)、思考区自动折叠、输入历史导航 |
| 任务规划系统 | 三道防线（用户消息注入 + System Prompt + 首轮检查）、Plan Gate 强制步骤完成、断路器防死循环 |
| Plan Parser | 宽松解析模型输出中的 📋 checklist，支持多种编号格式，自动去重 |
| 右侧面板统一 | Git + Plan + Process 三合一右侧悬浮面板，计划 5 条默认折叠，显示执行时间 |
| Goal 自主循环 | `/goal` 前缀触发：自动制定计划 → 执行 → 验证 → 失败重试，最多 N 轮或超时自动终止 |
| 子智能体调度 | SubagentDispatcher 调度 explor/review/implement 子 Agent，流式输出思考过程和工具调用到主 UI |

## 相关源码

| 模块 | 路径 |
|------|------|
| 应用身份隔离 (dev/发版) | `src/main/app-identity.ts` |
| 启动适配器 | `scripts/launch-dev.js` |
| Agent Worker (多 Session) | `src/worker/agent-worker.ts` |
| Agent 核心 | `src/worker/agent/agent.ts` |
| Agent 循环 | `src/worker/agent/agent-loop.ts` |
| 流式处理器 | `src/worker/agent/stream-handler.ts` |
| 流式工具预执行器 | `src/worker/agent/streaming-executor.ts` |
| 回合决策 | `src/worker/agent/turn-decision.ts` |
| Stop Hooks | `src/worker/agent/stop-hooks.ts` |
| Goal 自主循环 | `src/worker/agent/goal-loop.ts` |
| 计划模式 | `src/worker/agent/plan-mode.ts` |
| 系统提示词生成 | `src/worker/agent/system-prompt.ts` |
| Skills 加载器 | `src/worker/agent/skills.ts` |
| Memory 记忆系统 | `src/worker/agent/memory.ts` |
| Lessons 教训系统 | `src/worker/agent/lessons.ts` |
| 上下文压缩 | `src/worker/agent/context-budget.ts` |
| 子智能体调度器 | `src/worker/agent/subagent.ts` |
| 工具注册中心 | `src/worker/tools/registry.ts` |
| 工具实现 | `src/worker/tools/*.ts` |
| 后台进程监控 | `src/worker/tools/background-process-monitor.ts` |
| MCP 集成 | `src/worker/mcp/*.ts` |
| 聊天面板 | `src/renderer/components/chat/ChatPanel.vue` |
| 消息列表 (自动滚动) | `src/renderer/components/chat/MessageList.vue` |
| 输入框 | `src/renderer/components/chat/ChatInput.vue` |
| 前端工具卡片 | `src/renderer/components/tools/*.vue` |
| 思考区组件 | `src/renderer/components/chat/AssistantMessage.vue` |
| 运行事件日志 | `src/main/run-store.ts` |
| 会话持久化 | `src/main/session-store.ts` |
| IPC 桥接 | `src/main/ipc-handlers.ts` / `src/main/preload.ts` |
