# 技能系统设计

日期: 2026-09-17 | 状态: 已实现

---

## 概述

技能系统（Skills）从一组约定目录加载 `.md` 技能文件，并只把**技能索引**（名称 + 描述 + 文件路径）注入 system prompt。模型在任务匹配某条技能描述时，用 `read` 工具按路径加载全文。

这样做的收益是**用固定的小成本换随目录增长的领域知识**：无论用户装了多少技能，system prompt 里的常驻体积只随"技能条数 × 一行"增长，技能正文永远按需读取。

**核心原则：**

- **索引而非全文**：常驻 prompt 只含 name + description + path
- **懒加载**：模型判断匹配后才 read 正文（Do not guess the skill content — always read it first.）
- **分层覆盖**：内置 → 厂商 → 项目 → 用户 → 附加路径，后者同名覆盖前者
- **约定对齐**：采用 agentskills.io / pi 的 `SKILL.md` 目录约定

---

## 加载来源与优先级

`loadAllSkills` 按固定顺序收集，同名去重时**后进者覆盖先进者**：

| 顺序 | 来源 | 目录 |
|---|---|---|
| 1 | 内置（随应用发版） | 生产 `process.resourcesPath/skills`；开发 `__dirname/../../skills` |
| 2 | 厂商技能 | `getVendorSkillDirectories(homeDir)` 返回的路径 |
| 3 | 项目 | `{workingDir}/.suncode/skills` |
| 4 | 用户 | `{homeDir}/.suncode/skills` |
| 5 | 附加路径 | 调用方传入的 `additionalPaths` |

去重键为**技能名**（frontmatter `name` 或文件名），因此项目/用户技能可覆盖内置技能。被 `disabledSkillPaths` 命中的文件在去重前被剔除。最终按 `metadata.priority` **降序**排序。

---

## 目录与文件形态

`loadSkillsFromDir` 同时支持两种布局：

- **扁平文件**：`<dir>/<name>.md`
- **子目录（agentskills.io 约定）**：`<dir>/<name>/SKILL.md`

目录不存在或单个文件读取失败时静默跳过——技能缺失不应让 agent 启动失败。

---

## Frontmatter

文档头部 `---` 包裹的 YAML 子集被解析（`parseFrontmatter`），支持字段：

| 字段 | 用途 |
|---|---|
| `name` | 技能名（决定覆盖关系与命令名） |
| `description` | 索引里展示给模型的匹配依据 |
| `trigger` | 触发线索（当前仅捕获，不参与调度） |
| `priority` | 排序权重，越大越靠前 |

正文在解析后**剥离 frontmatter**（`stripFrontmatter`）再进入 `content`。

---

## 注入内容

`formatSkillsForPrompt` 生成的是一段**索引**，不含技能正文：

~~~
The following skills are available. When a task matches a skill description,
use the **read** tool to load the skill file at the listed path BEFORE starting work.
If the user invokes a listed /skill-command, load that exact skill before replying.
Do not guess the skill content — always read it first.

- **<name>** (command: /skill-<name>): <description>
  Path: <absolute path>
~~~

命令名由 `toSkillCommandName`（`@shared/commands`）生成，与前端斜杠命令菜单共用同一套命名。空技能集返回空串，不注入任何内容。

---

## 缓存

`preloadSkills` 以 `JSON.stringify([workingDir, additionalPaths, disabledSkillPaths])` 为键预热一次加载结果；`createSkillsLoader().loadAll()` 命中缓存时消费并删除该条目（一次性）。键变化（换工作目录、增删禁用路径）即触发重新加载。

---

## 关键约束

1. **只注入索引** — 技能正文永不进 system prompt，唯一入口是模型主动 `read`
2. **同名覆盖** — 覆盖率取决于加载顺序（项目/用户 > 内置）
3. **失败静默** — 目录缺失、文件不可读均跳过，不阻断启动
4. **优先级排序** — `priority` 降序；缺省视为 0

---

## 相关源码

| 模块 | 路径 |
|---|---|
| 加载器与格式化 | `src/worker/agent/skills.ts` |
| 来源目录解析 | `src/shared/skill-directories.ts`（`getVendorSkillDirectories`） |
| 命令名生成 | `src/shared/commands.ts`（`toSkillCommandName`） |
| 注入点 | `src/worker/agent/system-prompt.ts`（`skillsContent`） |
| 测试 | `test/agent/skills.test.ts` |
