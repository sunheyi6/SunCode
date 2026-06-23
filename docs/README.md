# SunCode 设计文档

## 文档索引

| 文档 | 说明 |
|------|------|
| [系统提示词设计](system-prompt-design.md) | System Prompt 构建：角色定义、Tool Discipline 反循环规则、一行式工具摘要、XML 结构化上下文、Token 优化 |
| [工具调用设计](tool-calling-design.md) | 工具架构：回合事件 (turn_start/end)、参数验证、前端工具卡片 (Command/File/Inspect)、数据流 |
| [上下文压缩设计](context-compaction-design.md) | 通过 `prepareNextTurn` 钩子自动压缩：触发策略、消息保留、与 Agent Loop 集成 |

## 2026-06 架构变更摘要

| 变更 | 说明 |
|------|------|
| Tool Usage Discipline | 新增反循环规则章节，防止模型无限调用工具 |
| 工具一行式摘要 | 替代完整 JSON Schema，节省 ~60% 工具 token |
| `<project_context>` XML | 结构化注入 .agents.md / Skills，遵循 pi/Codex 约定 |
| `prepareNextTurn` 钩子 | 回合间上下文压缩 + 未来动态换模型的扩展点 |
| `turn_start` / `turn_end` 事件 | 回合边界感知，前端展示进度（第N轮）|
| 工具参数运行时验证 | 必填参数检查 + 类型强制转换 |
| 前端工具卡片优化 | FileInspectCard (read/glob/grep)、思考区自动折叠、输入历史导航 |

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
