/**
 * /init command handler
 *
 * Detects the /init slash command and returns a specialized prompt
 * that tells the AI to scan the project and generate AGENTS.md
 * focused on project constraints.
 */

/** The initialization instruction prompt sent to the model. */
const INIT_PROMPT = `你是一个项目初始化专家。请为当前项目生成 AGENTS.md 文件。

## 任务

扫描当前项目的目录结构、package.json、配置文件、README 等，理解项目的性质和技术栈，然后生成一份 AGENTS.md 文件。

## AGENTS.md 的内容要求

AGENTS.md 的核心是**项目约束**——即 AI 在操作该项目时必须遵守的规则和约定。

### 必须包含的约束类型

1. **技术栈约束**：使用的语言、框架、构建工具、包管理器等
2. **代码风格约束**：命名规范、代码风格偏好、lint/typecheck 策略等
3. **架构约束**：项目架构分层、模块边界、依赖方向等
4. **开发流程约束**：启动命令、测试命令、构建命令等
5. **文档引用**：不要把详细的实现文档写进 AGENTS.md。如果项目有文档（如 docs/ 目录），在约束中引用即可，例如："详细架构文档请参考 docs/architecture.md"

### 约束原则

- **聚焦约束，而非描述**：AGENTS.md 说"应该怎么做"，而不是"项目是什么"
- **保持精简**：约束是底线规则，不是百科全书
- **引用外部文档**：详细的设计文档、API 文档等放在 docs/ 目录，AGENTS.md 只需引用它们
- **可执行**：每一条约束都应该是 AI 可以遵循的具体规则

### AGENTS.md 的格式

使用 Markdown 格式，按以下结构组织：

- "# {项目名}" 标题
- "## 项目约束" —— 核心约束列表
- 其他可选章节如 "## 架构概览"、"## 构建与发布" 等（如果项目有相关内容）

## 输出

直接执行：使用 write 工具将 AGENTS.md 写入项目根目录。
完成后告知用户文件已生成。`;

/**
 * Detect /init command and return the specialized initialization prompt.
 * Returns null if the text is not an /init command.
 */
export function parseInitCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/init')) return null;

  return INIT_PROMPT;
}
