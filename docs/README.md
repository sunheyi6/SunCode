# SunCode 设计文档

## 文档索引

| 文档 | 说明 |
|------|------|
| [系统提示词设计](system-prompt-design.md) | 如何构建 System Prompt：角色定义、行为准则、工具引导、Skills 注入、提示词占比分析 |
| [工具调用设计](tool-calling-design.md) | 6 个内置工具的设计：read/write/edit/bash/grep/glob、ToolRegistry 架构、MCP 集成、并行执行 |
| [上下文压缩设计](context-compaction-design.md) | 长对话上下文管理：触发策略、压缩粒度、摘要生成（规则式 vs LLM 驱动）、Token 估算 |

## 相关源码

| 模块 | 路径 |
|------|------|
| 系统提示词生成 | `src/worker/agent/system-prompt.ts` |
| Skills 加载器 | `src/worker/agent/skills.ts` |
| 上下文压缩 | `src/worker/agent/compaction.ts` |
| 工具注册中心 | `src/worker/tools/registry.ts` |
| 工具实现 | `src/worker/tools/*.ts` |
| Agent 循环 | `src/worker/agent/agent-loop.ts` |
| MCP 集成 | `src/worker/mcp/*.ts` |
| Token 估算 | `src/worker/utils/token-counter.ts` |
