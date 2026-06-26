# SunCode

## 项目约束

- **唯一实例**：本项目只运行一个开发服务器实例，端口固定为 `5173`（配置 `strictPort: true`）。启动前必须先检查并终止占用 5173 端口的旧进程。
- **启动命令**：`npm run dev`，访问地址 `http://localhost:5173/`
- **禁止切换端口**：如果端口 5173 被占用，不要尝试其他端口，必须先清理旧进程再启动。

## 架构概览

```
Electron Main Process (ipc-handlers.ts)
  ├── Worker Thread (agent-worker.ts)
  │     ├── Agent (agent.ts)
  │     │     ├── AgentLoop (agent-loop.ts) — LLM 调用 + 工具执行
  │     │     ├── GoalLoop (goal-loop.ts) — 多轮目标驱动
  │     │     ├── StopHooks (stop-hooks.ts) — 后处理检查
  │     │     ├── ContextBudget (context-budget.ts) — 上下文压缩
  │     │     ├── SubagentSystem (subagent.ts) — 子代理分发
  │     │     ├── Skills (skills.ts) — 技能文件加载
  │     │     ├── Memory — 项目记忆持久化
  │     │     └── MCP (mcp/) — 外部工具服务器
  │     └── Tools (tools/) — 10 个内置工具
  └── Renderer (Vue 3 + Pinia)
        ├── ChatPanel — 对话区域
        ├── CallTracePanel — 调用轨迹
        ├── ConversationSidebar — 会话列表
        ├── ConfirmDialog — 权限确认弹窗
        └── SettingsPanel — 设置
```

## 关键设计决策

### 1. 权限系统 — 四模式硬拦截

**四种模式**：`plan`（只读）| `full_access`（无限制）| `auto_edit`（自动编辑）| `confirm_changes`（变更确认）

**实现机制**：
- **plan 模式**：在 Tool 接口新增 `isReadonly` 标记，`Agent.getEffectiveTools()` 过滤工具列表。写工具（write/edit/bash/subagent）完全不可用。
- **confirm_changes 模式**：`AgentLoop` 执行非只读工具前调用 `requestConfirmation` 回调 → Worker → Main → Renderer（Vue 弹窗）→ 用户确认/拒绝 → 回传 Worker。
- 确认超时 2 分钟默认拒绝，防止永久阻塞。

**涉及文件**：`tools/types.ts`（isReadonly）| `agent.ts`（getEffectiveTools）| `agent-loop.ts`（confirm 拦截）| `agent-worker.ts`（IPC 往返）| `ConfirmDialog.vue`（弹窗 UI）| `ipc-handlers.ts`（转发）

### 2. AI 标题生成

**流程**：新建会话 → 即时标题（文本截取）→ 后台异步调用 `pi-ai streamSimple` → `TITLE_GENERATION_PROMPT` 要求返回 JSON `{"title":"..."}` → 解析后更新会话名 → IPC `session:updated` 通知渲染进程。

**关键点**：fire-and-forget 异步，不阻塞消息保存；JSON 格式约束确保可解析。

**涉及文件**：`ipc-handlers.ts`（generateTitleWithAI）| `constants.ts`（TITLE_GENERATION_PROMPT）

### 3. 系统提示词精简

**优化点**：
- 语言规则从 7 行压缩到 3 行，去掉冗余强调
- Identity 从 5 条压缩到 2 条
- 删除 `Tool Usage Guidelines` 段落（8 条规则），工具自身的 `description` 已足够
- 增加"影响范围评估"规则

**设计原理**：参考 Claude Code 的 prompt 设计，工具描述自给自足，不在系统提示中重复规则。静态缓存前缀尽可能短。

### 4. Session 目录同步

**问题**：用 📁 创建新会话时 Worker 只收到 `setMessages`，未收到 `setWorkingDir`，导致 Agent 仍操作旧目录。

**修复**：`session:create` 处理中增加 `sendToWorker({ type: 'setWorkingDir', path })`。

**涉及文件**：`ipc-handlers.ts`

### 5. 发布流程（GitHub Actions）

**流程**：`build`（三平台并行）→ `release`（汇总校验 + 生成 SHA256 + Release Notes + `gh release create`）

**关键设计**：
- `concurrency: group=release-{tag}` 防重复构建
- 发布前验证三平台 binary 均存在
- Release Notes 自动包含 SHA256 表格
- 参考 `earendil-works/pi` 的设计

**涉及文件**：`.github/workflows/release.yml` | `electron-builder.yml` | `package.json`

### 6. 调用轨迹面板

**CallTracePanel**：右侧面板，展示每次 Agent 调用的完整链路：
- 系统提示词（默认截断 500 字符，可展开）
- 思考过程（thinking）+ 工具调用按 `thinkingOffset` 交错排列
- 工具卡片按类型分组件（SubagentCard、CommandOperationCard、FileOperationCard、FileInspectCard）
- 滚动修复：`min-height: 0` 确保 flex 布局中 `overflow-y: auto` 生效

### 7. 结构化克隆修复

**问题**：Vue 响应式 Proxy 对象通过 Electron IPC 时 `structuredClone` 失败。

**修复**：`buildPersistedAssistantMessage` 返回前 `JSON.parse(JSON.stringify(message))` 剥离所有 Reactive 包装。

## 技术栈

- **Runtime**: Electron 42 + Node.js 22 + Worker Threads
- **AI**: @earendil-works/pi-ai (streamSimple, 30+ providers)
- **Frontend**: Vue 3 + Pinia + Vite 6
- **MCP**: @modelcontextprotocol/sdk (stdio transport)
- **Build**: electron-builder 25 (Win NSIS/Portable, Mac DMG arm64, Linux AppImage/deb)
- **CI**: GitHub Actions, trigger on `v*` tag push

## 项目上下文文件

此 `CLAUDE.md` 同时作为 SunCode Agent 的项目上下文加载。Agent 启动时会按优先级搜索：
`.agents.md`（Codex）→ `CLAUDE.md`（Claude Code）→ `AGENTS.md`（旧格式），优先使用第一个找到的文件。

也就是说，在 SunCode 中打开本项目的目录时，Agent 会自动读入此文档作为系统提示的 `<project_context>` 段落。
