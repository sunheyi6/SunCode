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
│ 1. 角色定义 (Identity)               │  ← 你是谁
├─────────────────────────────────────┤
│ 2. 能力说明 (Capabilities)           │  ← 你能做什么
├─────────────────────────────────────┤
│ 3. 行为准则 (Guidelines)             │  ← 你应该怎么做
├─────────────────────────────────────┤
│ 4. 工具调度纪律 (Tool Discipline)     │  ← ★ 最关键的反循环规则
├─────────────────────────────────────┤
│ 5. 环境信息 (Environment)            │  ← 你在哪里工作
├─────────────────────────────────────┤
│ 6. <project_context> (如有)          │  ← .agents.md 项目约束 (XML)
├─────────────────────────────────────┤
│ 7. 工具摘要 (Tools - 一行式)          │  ← ★ 省 token 的工具摘要
├─────────────────────────────────────┤
│ 8. <available_skills> (如有)         │  ← Skills 领域知识 (XML)
├─────────────────────────────────────┤
│ 9. 开始指令 (Begin)                  │  ← 开始工作吧
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

### 3.3 行为准则

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

### 3.4 工具调度纪律 (Tool Usage Discipline) ★ 新增

这是 2026-06 针对 DeepSeek 等模型反复调用工具的循环问题新增的关键章节，
参考 Codex / pi 项目的反循环设计。分三个子节：

**When to STOP using tools** — 明确"什么时候该停手"
- 1-3 次工具调用后必须评估是否已够回答
- 浏览类请求（"查看项目结构"）最多 2 次工具调用后就汇总
- Bug 修复：读相关文件 → 找根因 → 修 → 停
- 如果发现自己要重复执行同一个命令，立即停止

**Anti-looping rules** — 防止无限工具循环
- 同一命令不准执行两次
- 信息类请求不准超过 2-3 轮
- 找到答案后不准继续探索无关文件
- 不确定时直接回应"我找到了这些，需要深入吗？"

**Response format for informational requests** — 结构化回答格式
- 浏览类请求必须输出：高层概述 + 组织好的信息 + 可选的深入提示
- 明确告知：每次额外的工具调用都在消耗用户时间

### 3.5 工具摘要 (一行式) ★ 重新设计 |

### 3.4 环境信息

```
## Environment
- Working directory: /Users/user/project
- Operating system: darwin
- Date: 2026-06-22
- Maximum turns: 50
```

动态注入运行时环境变量，让模型感知其所处的环境。`Maximum turns` 限制让模型知道它有有限的操作次数，促使其高效工作。

### 3.5 工具摘要 (一行式) ★ 重新设计

**旧设计**：每个工具展开完整 JSON Schema（~200 字符/工具，6 工具 ≈ 1200+ 字符），
占用大量系统提示 token。

**新设计**：参考 pi 项目的 `toolSnippets` 方案，每个工具用一行摘要描述：

```
- **read**: Read file contents with line numbers. `file_path` (required), `offset`, `limit`.
- **write**: Create or overwrite a file. `file_path` and `content` required.
- **edit**: Exact string replacement. `file_path`, `old_string`, `new_string` required.
- **bash**: Execute a shell command. `command` (required), `description`, `timeout`.
- **grep**: Regex search via ripgrep. `pattern` (required), `path`, `glob`, `type`.
- **glob**: Find files by glob pattern. `pattern` required (e.g. "**/*.ts").
```

完整 JSON Schema 仍然通过 `tool.getDefinition()` 提供给 function-calling
provider 的 API 层使用，但不再占用系统提示 token。

**Token 节省**：旧格式 ~1200 chars → 新格式 ~450 chars，节省 ~60%。

**关键设计**：
- 每行包含：`name` + 一句话功能 + 必需参数列表
- 参数用反引号标注，一目了然
- 按照 pi 项目的实践，LLM 不需要完整 Schema 也能正确选工具——provider 的 function calling 机制会处理参数详情

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

### 3.7 结构化上下文注入

Skills 和 Workspace 指令采用结构化 XML 标签组织，遵循 pi / Codex 的设计约定：

**`<project_context>`** — 来自 `.agents.md` 的项目级约束：
```xml
<project_context>
<!-- .agents.md 的内容 -->
- 代码风格要求
- 部署规则
- 安全约束
</project_context>
```

**`<available_skills>`** — 来自 Skill 文件的领域知识：
```xml
<available_skills>
<!-- Skills 内容 -->
- 特定框架的编码规范
- 项目工具链的使用说明
</available_skills>
```

XML 标签让模型能清晰区分"通用指令"和"项目特定规则"。
参考 [agentskills.io](https://agentskills.io) 约定和 pi 项目的 `<project_instructions>` 实践。

### 3.8 `.agents.md` 加载

遵循 Codex 约定，加载两级 `.agents.md`：
1. 项目级：`<workspace>/.agents.md`（fallback `AGENTS.md`）
2. 用户级：`~/.agents.md`

两者合并后注入 `<project_context>` 标签。该内容通过
`AgentLoopInput.agentsMdContent` 传入 `buildSystemPrompt()`。

---

## 4. 提示词生成流程

```
Agent.runLoop()
    │
    ├─ loadAgentsMd(workingDir)        // .agents.md / AGENTS.md
    ├─ skillsLoader.loadAll()          // Skills 内容
    │
    ├─ buildSystemPrompt({
    │     workingDir,      // 进程 cwd
    │     tools,           // ToolRegistry.getDefinitions()
    │     skillsContent,   // SkillsLoader.loadAll()
    │     maxTurns,        // 用户设置
    │     agentsMdContent, // .agents.md 内容 (v2026-06 新增)
    │     customPrompt,    // 可选的自定义提示词
    │  })
    │
    ├─ getToolSnippet()    // 一行工具摘要（替代完整 JSON Schema）
    │
    ├─ 结构化注入:
    │   ├─ <project_context>agentsMdContent</project_context>
    │   └─ <available_skills>skillsContent</available_skills>
    │
    └─ 放入 piContext.systemPrompt → 发送给 LLM
```

### 提示词大小对比

| 部分 | 旧设计 (chars) | 新设计 (chars) | 节省 |
|------|---------------|---------------|------|
| 工具 Schema | ~1200 | ~450 | -62% |
| 反循环规则 | 0 | ~600 | 新增 |
| 结构化 XML 标签 | 0 | ~50 | 新增 |
| **总计** | ~3400 | ~2800 | -18% |

虽然加了反循环规则，因工具摘要大幅缩减，总提示词反而减少了 ~18%。

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
