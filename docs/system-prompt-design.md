# 系统提示词设计文档

## 1. 设计目标

系统提示词（System Prompt）是 AI coding agent 的核心指令集，决定了模型如何理解任务、使用工具、组织回答。设计目标：

- **角色清晰**：让模型明确自己是 coding agent，而非通用助手
- **行为约束**：规范模型如何探索代码、编辑文件、执行命令
- **工具引导**：教会模型何时使用哪个工具，如何正确传参
- **安全边界**：防止破坏性操作（如 `rm -rf /`）
- **可扩展**：支持 Skills 注入领域知识，支持 MCP 动态工具

---

## 2. 提示词结构

```
┌─────────────────────────────────────┐
│ 1. 角色定义 (Role)                   │  ← 你是谁
├─────────────────────────────────────┤
│ 2. 能力说明 (Capabilities)           │  ← 你能做什么
├─────────────────────────────────────┤
│ 3. 行为准则 (Guidelines)             │  ← 你应该怎么做
├─────────────────────────────────────┤
│ 4. 环境信息 (Environment)            │  ← 你在哪里工作
├─────────────────────────────────────┤
│ 5. 工具列表 (Tools)                  │  ← 你有哪些工具
├─────────────────────────────────────┤
│ 6. 工具使用指南 (Tool Guidelines)     │  ← 怎么用工具
├─────────────────────────────────────┤
│ 7. Skills 注入 (Skills)              │  ← 领域知识
├─────────────────────────────────────┤
│ 8. 最终指令 (Final Instruction)       │  ← 开始工作吧
└─────────────────────────────────────┘
```

---

## 3. 各模块设计详解

### 3.1 角色定义

```
You are SunCode, an expert software engineer AI assistant running as a desktop application.
Your purpose is to help users write, understand, debug, and refactor code.
```

**设计要点**：
- 用 `expert software engineer` 而非 `coding assistant`，引导模型以高级工程师思维工作
- 明确"桌面应用"身份，区别于浏览器环境
- 目标动词清晰：write / understand / debug / refactor

### 3.2 能力说明

简明列出模型能执行的操作类型，这帮助模型在决策时知道自己能做什么：

- 读/写/编辑/搜索文件
- 执行 shell 命令
- 分析代码库结构
- 提供解释和建议

### 3.3 行为准则（最核心）

这是直接影响模型行为质量的部分，每条准则都解决一类常见问题：

| # | 准则 | 解决的问题 |
|---|------|-----------|
| 1 | Be concise but thorough | 防止过度啰嗦 |
| 2 | Show before/after diff when editing | 让用户可视化变更 |
| 3 | Explain reasoning before changes | 建立信任，可审查 |
| 4 | Gather info before answering | 防止模型假设文件内容 |
| 5 | Explain root cause before fixing bugs | 教育用户，防止表面修复 |
| 6 | Read files instead of assuming | **最关键**：防止幻觉 |
| 7 | Respect existing code style | 保持代码库一致性 |
| 8 | Include clear command descriptions | bash 工具要求 |
| 9 | Ask for clarification, don't guess | 防止错误操作 |
| 10 | Use parallel tool calls | 提升效率 |

### 3.4 环境信息

```
## Environment
- Working directory: /Users/user/project
- Operating system: darwin
- Date: 2026-06-22
- Maximum turns: 50
```

动态注入运行时环境变量，让模型感知其所处的环境。`Maximum turns` 限制让模型知道它有有限的操作次数，促使其高效工作。

### 3.5 工具列表

对每个工具生成结构化的描述和 JSON Schema：

```
### read
Reads a file from the local filesystem.
Parameters:
```json
{
  "type": "object",
  "properties": {
    "file_path": { "type": "string", "description": "..." },
    "offset": { "type": "integer", "description": "..." },
    "limit": { "type": "integer", "description": "..." }
  },
  "required": ["file_path"]
}
```
```

**关键设计**：
- `description` 字段决定模型何时选择该工具——要写得像"使用场景说明"
- `required` 字段让模型知道哪些参数必须提供
- 参数 `description` 要包含默认值、范围、格式要求

### 3.6 工具使用指南

明确的工具使用规则，列举了常见的正确/错误用法：

```
1. You may call multiple tools in a single response when operations are independent.
2. Always read files before editing them - never assume file contents.
3. When making edits, use the edit tool with exact string matching.
4. When executing bash commands, include clear descriptions of what each command does.
5. Search for code patterns with grep before making broad changes.
6. If a tool returns an error, analyze the error and adjust your approach.
7. After completing all necessary changes, respond with a summary of what was done.
```

### 3.7 Skills 注入

Skills 是 Markdown 文件，通过 frontmatter 声明元数据：

```yaml
---
description: Code review best practices
trigger: [review, pr, check]
priority: 10
---
```

加载逻辑：
1. 搜索 `.suncode/skills/` (项目级) 和 `~/.suncode/skills/` (用户级)
2. 解析 YAML frontmatter 获取优先级、触发条件
3. 按优先级排序，注入到系统提示词 `## Skills` 段
4. 未来可基于 `trigger` 关键词做按需加载

---

## 4. 提示词生成流程

```
createAgentSession()
    │
    ├─ buildSystemPrompt({
    │     workingDir,      // 进程 cwd
    │     tools,           // ToolRegistry.getAll()
    │     skillsContent,   // SkillsLoader.loadAll()
    │     maxTurns,        // 用户设置
    │     customPrompt,    // 可选的自定义提示词
    │  })
    │
    ├─ 组合各部分为最终字符串
    │
    └─ 放入 Context.system → 发送给 LLM
```

---

## 5. 经验总结

### ✅ 有效实践

1. **版本化提示词**：系统提示词应像代码一样版本管理，每次改动记录效果
2. **先读后写**：Rule #6 重复了 3 次（Guideline #6 + Tool Guideline #2 + Rule #2），因为这是模型最常见的错误
3. **显式优于隐式**：工具参数说明中包含"默认值是多少""合法范围是什么"
4. **约束工具选择**：告诉模型在哪些场景下用哪个工具，而不是让模型自己猜

### ❌ 常见反模式

1. **过度约束**：太多"Don't"规则会让模型变得被动、不敢行动
2. **缺少示例**：工具用法只有 Schema 没有示例，模型容易传错参数
3. **忽略容错**：不告诉模型"工具失败了该怎么办"，它可能循环重试同一个错误参数
4. **提示词过长**：系统提示词占 context window 太大比例，压缩了对话空间

### 📊 提示词占比

| 模型 | Context Window | 典型 System Prompt | 占比 |
|------|---------------|-------------------|------|
| Claude Sonnet 4.5 | 200K | ~3K tokens | 1.5% |
| GPT-5.1 Codex | 128K | ~3K tokens | 2.3% |
| Gemini 2.5 Pro | 1M | ~3K tokens | 0.3% |

保持系统提示词在 2000-4000 tokens 是最佳范围。
