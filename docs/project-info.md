# SunCode 项目信息

> 应用运行时路径、环境信息、构建和版本信息。
> 发版时随应用打包，Agent 可按需读取本文件回答用户关于项目配置和路径的问题。

---

## 应用身份

| 属性 | 开发模式 | 生产模式 |
|------|---------|---------|
| 应用名 | `SunCode Dev` | `SunCode` |
| 判断条件 | `app.isPackaged === false` | `app.isPackaged === true` |
| appId / AppUserModelId | `com.suncode.app.dev` | `com.suncode.app` |
| 产品名 | `SunCode` | `SunCode` |

> 开发模式下调用 `app.setName('SunCode Dev')` 使 userData 目录独立，避免与生产版本的数据冲突。
> Windows 上开发/生产使用不同 `AppUserModelId`，并在启动时维护带对应 AUMID 的开始菜单快捷方式（`windows-toast-shortcut.ts`），避免 Toast 点击误启 `Electron.lnk` / 裸 `electron.exe`。
> 判断逻辑见 `src/main/app-identity.ts`，通过 `IS_DEV` 导出、通过 `SUNCODE_IS_DEV` 环境变量传递给 Worker。

## Agent 项目自认识入口

SunCode 自身的使用、配置和排障统一由内置 `suncode` skill 导航。Agent 遇到相关请求时，先读取 skills 索引中的该 skill，再读取 `context.projectKnowledge.entryPath` 指向的会话级 `runtime/project-info.md`。skill 随应用打包，详细知识复用本目录文档，按需读取。当前工作目录可能是其他项目，不应在其中搜索 SunCode 内部实现。

入口文档在每次 Agent 运行开始时生成，包含当前 Provider、模型、思考级别、工作目录、应用数据目录、全局约束文件的实际路径和存在状态，以及设计文档的绝对索引路径；不写入 API Key 等密钥。生产环境文件位于 `{userData}/.suncode/sessions/{sessionId}/runtime/project-info.md`，无头模式写入系统临时目录，避免污染被操作的项目。

### 全局用户约束

全局用户约束文件为 `~/.suncode/AGENTS.md`，位于 SunCode 专属的用户配置目录。主目录按 `HOME`、`USERPROFILE`、系统主目录依次解析，实际路径以运行时入口为准。用户要求保存全局规则时，读取并合并该文件；不存在则创建文件及所需父目录，保留已有内容，完成后回读验证。后续 Agent 新运行会重新加载，对所有项目生效，不依赖 skill 是否被调用或记忆检索是否命中。

旧路径 `~/.agents.md` 不再读取。升级时如需保留旧规则，应将其内容合并到 `~/.suncode/AGENTS.md`，保留新文件中已有的规则。

项目级依次尝试工作目录下的 `CLAUDE.md`、`AGENTS.md`，成功读取第一个文件后停止（即使内容为空），然后合并全局约束。不会自动加载 `~/.codex/AGENTS.md`。加载实现位于 `src/worker/agent/agent-instructions.ts`，运行时入口复用同一个路径解析函数。

---

## 数据目录

数据目录通过 `app.getPath('userData')` 解析，开发/生产因 `app.setName()` 不同而路径不同。

| 模式 | userData 路径 |
|------|--------------|
| 开发 | `%APPDATA%\SunCode Dev` （Windows） |
| 生产 | `%APPDATA%\SunCode` （Windows） |

所有应用数据存储在 `{userData}/.suncode/` 目录下：

> 路径解析见 `src/main/paths.ts` 的 `getAppDataDir()` 函数。

---

## 诊断日志

| 日志类型 | 开发模式路径 | 生产模式路径 |
|----------|-------------|-------------|
| 主进程日志 | `%APPDATA%\SunCode Dev\.suncode\app.log` | `%APPDATA%\SunCode\.suncode\app.log`（自动轮转，≥2MB → `app.old.log`） |
| Agent 运行时诊断 | `%APPDATA%\SunCode Dev\.suncode\diagnostics\{runId}.log` | `%APPDATA%\SunCode\.suncode\diagnostics\{runId}.log`（每次运行独立文件） |
| 运行事件 | `%APPDATA%\SunCode Dev\.suncode\sessions\{sessionId}\runs\{runId}.jsonl` | `%APPDATA%\SunCode\.suncode\sessions\{sessionId}\runs\{runId}.jsonl`（每次运行独立 JSONL 文件） |
| Bash 后台输出（harness 层） | `%USERPROFILE%\.zcode\cli\exec\sess_{sessionId}\call_{callId}-stdout.log` | `%USERPROFILE%\.zcode\cli\exec\sess_{sessionId}\call_{callId}-stdout.log` |

### 日志级别

| 模式 | 文件日志级别 | 控制台输出 |
|------|-------------|-----------|
| 开发模式 | `debug` | 完整输出（`debug` 级别） |
| 生产模式 | `info` | 仅警告和错误（`warn` 级别） |

- 主进程日志使用 electron-log，见 `src/main/logger.ts`
- Agent 诊断日志见 `src/worker/utils/diag-logger.ts`

---

## 运行事件与 Token 用量

| 内容 | 路径 |
|------|------|
| 运行事件 (JSONL) | `{userData}/.suncode/sessions/{sessionId}/runs/{runId}.jsonl` |
| Token 用量聚合 | `{userData}/.suncode/token-usage.json` |

> 运行事件存储见 `src/main/run-store.ts`。

---

## 记忆文件

| 范围 | 路径 |
|------|------|
| 全局 | `{userData}/.suncode/memories/` |
| 项目级 | `{project}/.suncode/memories/` |
| 会话级 | `{project}/.suncode/memories/sessions/{sessionId}/` |

> 记忆系统实现见 `src/worker/agent/memory.ts`。

---

## 教训文件

| 路径 |
|------|
| `{project}/.suncode/lessons/` |

> 教训系统实现见 `src/worker/agent/lessons.ts`。

---

## 配置文件

| 文件 | 路径 |
|------|------|
| 应用设置 | `{userData}/.suncode/settings.json` |
| 会话数据 | `{userData}/.suncode/sessions/{sessionId}/` |

> 会话持久化见 `src/main/session-store.ts`。

---

## 内置 Skills 目录

| 模式 | 路径 |
|------|------|
| 发版（打包后） | `process.resourcesPath/skills/`（`resources/skills/`） |
| 开发 | 项目 `skills/` 目录（`{project}/skills/`） |

> Skills 加载见 `src/worker/agent/skills.ts` 的 `getBuiltinSkillsDir()`。

---

## 构建与发布

| 命令/触发 | 说明 |
|-----------|------|
| `bun run electron:build` | 本地打包当前平台 |
| 推送 `v*` 格式 tag | 触发 GitHub Actions 三平台构建 |
| 构建工具 | electron-builder |
| 构建配置 | `electron-builder.yml` |
| 构建产物目录 | `release/` |

### 构建产物

| 平台 | 格式 |
|------|------|
| Windows | `.exe` (NSIS 安装包 + Portable 便携版) |
| macOS | `.dmg` (arm64) |
| Linux | `.AppImage` + `.deb` |

### Windows 安装器 (NSIS)

| 属性 | 值 |
|------|-----|
| 安装器文件名 | `SunCode-Setup-{version}.exe` |
| 一键安装 | 否（允许选择安装目录） |
| 提权 | 允许 |
| 桌面快捷方式 | 始终创建 |
| 开始菜单快捷方式 | 创建 |
| 卸载时保留用户数据 | 是（`deleteAppDataOnUninstall: false`） |

### 发布目标

| 平台 | 地址 |
|------|------|
| GitHub Releases | `github.com/sunheyi6/SunCode` |
| 发布类型 | draft |

---

## 架构约定

- **单向依赖**：Electron Main → Worker Thread → Agent → AgentLoop
- **IPC 通信**：Renderer ↔ Main (contextBridge) ↔ Worker (postMessage)
- **工具接口**：`Tool` 接口；`isReadonly` 仅用于流式预执行调度
- **权限模式**：固定为 `full_access`，不提供模式切换或工具确认弹窗；文件工具可访问工作目录外路径
- **会话分组**：按 `workingDirectory` 分组，切换会话时同步 Worker 工作目录

---

## 项目约束

- 开发服务器端口固定 `5173`，`strictPort: true`，禁止切换端口
- 启动命令 `bun run dev`，由 `scripts/launch-dev.js` 启动器接管
- `bun run dev` 为长期运行服务，后台执行
- TypeScript strict 模式
- 代码质量：biome (lint errors) + tsc (typecheck)
- 推荐模型见 `src/shared/constants.ts` 的 `RECOMMENDED_MODELS`
- 轻量模型映射见 `LITE_MODELS`

---

## 设计文档

> 本文档打包在 `docs/` 目录下，Agent 可通过 `read` 工具按需读取。
> 开发模式下根目录为项目 `docs/`，发版后根目录为 `process.resourcesPath/docs/`。

完整文档索引见 `docs/README.md`，涵盖以下功能设计：

- 系统提示词构建
- 工具调用架构
- 上下文压缩策略
- 任务规划与结束判断
- 运行事件日志与 Token 用量追踪
- 会话标题生成
- 流式输出渲染
- 运行中引导注入
- 记忆与教训系统
- 技能系统
- 子智能体调度
- 前端组件设计（输入框、工具卡片、悬浮面板、调用链、Token 显示等）

---

*本文档随应用发版打包，版本与代码同步。*
