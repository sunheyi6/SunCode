# SunCode

AI 驱动的桌面编程助手客户端，基于 **Electron + Vue 3 + TypeScript** 构建。

## 功能特性

- 🤖 **多模型支持** — DeepSeek、Anthropic Claude、OpenAI、Google Gemini、xAI 等 30+ 厂商
- 🧠 **智能 Agent 循环** — 自动思考 → 工具调用 → 分析结果 → 继续执行
- 🔀 **子 Agent 委托** — 将独立任务交给专项 Agent 并行执行，避免主对话上下文污染
- 🛠 **内置工具** — bash（命令执行）、read/write/edit（文件操作）、grep/glob（代码搜索）
- 📊 **实时工具卡片** — 文件编辑显示 +/- 行数，命令执行显示输出流
- 💾 **会话持久化** — 聊天历史自动保存，支持恢复中断的对话
- 🔌 **MCP 协议** — 连接外部工具服务器（Model Context Protocol）
- 🌓 **明暗主题** — Catppuccin Mocha/Latte 双主题
- ⚡ **并行执行** — 同一轮中的独立工具调用并行运行，子 Agent 内部并发调度
- 💰 **Prompt 缓存** — 优化的 System Prompt 结构，配合 Anthropic 缓存降低 90% 前缀成本
- 🧪 **完整测试覆盖** — 借鉴 Kimi Code 和 pi 的测试规范，102 个测试用例

## 环境要求

- **Node.js** >= 22
- **Bun**（推荐的包管理器和运行时）

## 快速开始

```bash
# 安装依赖
bun install

# 启动开发环境（Vite + Electron）
bun run dev

# 生产构建
bun run build

# 打包桌面应用
bun run electron:build
```

## 开发与发版 app 隔离

开发模式（`bun run dev`）与打包后的发版 app 使用**相互独立**的应用身份，可同时运行互不干扰：

| | dev（未打包） | 发版 app（打包） |
|---|---|---|
| 应用名 | `SunCode Dev` | `SunCode` |
| userData 目录 | `%APPDATA%\SunCode Dev\` | `%APPDATA%\SunCode\` |
| 单实例锁 | 独立 key，与发版互不干扰 | 独立 key |
| 窗口标题 | `SunCode Dev` | `SunCode` |

隔离由 `src/main/app-identity.ts` 实现：该模块在主进程最先 import，在 `!app.isPackaged` 时调用 `app.setName('SunCode Dev')`。它必须在任何 `app.getPath('userData')` 调用前执行，否则 Windows 大小写不敏感会导致 dev（`suncode`）与发版（`SunCode`）共用锁和数据目录、互相顶替窗口。

## 项目结构

```
SunCode/
├── src/
│   ├── main/              # Electron 主进程，IPC 通信
│   │   ├── app-identity.ts  # dev/发版身份隔离（最先 import，独立 userData + 单实例锁）
│   │   ├── ipc-handlers.ts  # IPC 处理器
│   │   ├── preload.ts       # 预加载桥接
│   │   ├── session-store.ts # 会话持久化
│   │   └── run-store.ts     # 运行记录
│   ├── renderer/           # Vue 3 前端
│   │   ├── components/      # UI 组件
│   │   │   ├── chat/          # 聊天面板、消息渲染
│   │   │   ├── tools/         # 工具操作卡片（Subagent/File/Bash）
│   │   │   ├── layout/        # 布局组件
│   │   │   ├── settings/      # 设置面板
│   │   │   └── code/          # 代码视图（Diff/高亮）
│   │   ├── stores/          # Pinia 状态管理
│   │   ├── composables/     # Vue 组合式函数
│   │   ├── api/             # IPC 桥接层
│   │   └── styles/          # 全局样式、CSS 变量
│   ├── worker/             # Agent 工作线程
│   │   ├── agent/            # Agent 核心
│   │   │   ├── agent-loop.ts   # 主循环：LLM 调用 → 工具执行 → 循环
│   │   │   ├── system-prompt.ts# System Prompt 构建（缓存优化结构）
│   │   │   ├── subagent.ts     # 子 Agent 调度器（并行 + 深度守卫）
│   │   │   ├── compaction.ts   # 上下文压缩
│   │   │   ├── memory.ts       # 项目记忆系统
│   │   │   └── skills.ts       # Skills 加载
│   │   ├── tools/            # 工具实现
│   │   │   ├── bash.ts         # Shell 命令执行
│   │   │   ├── read.ts         # 文件读取
│   │   │   ├── write.ts        # 文件写入
│   │   │   ├── edit.ts         # 精确字符串替换
│   │   │   ├── grep.ts         # 正则搜索（ripgrep）
│   │   │   ├── glob.ts         # 文件模式匹配
│   │   │   └── subagent.ts     # 子 Agent 工具定义
│   │   ├── models/           # 模型注册（基于 pi-ai）
│   │   ├── mcp/              # MCP 客户端
│   │   └── utils/            # Token 计数、Git 工具
│   └── shared/             # 共享类型和常量
├── test/                   # 测试套件
│   ├── fixtures/            # 测试夹具（Fake Tool/Stream/Dispatcher）
│   ├── tools/               # 工具测试
│   ├── agent/               # Agent 核心测试
│   ├── utils/               # 工具函数测试
│   └── integration/         # 集成测试（并发、时序）
├── scripts/                # 独立脚本
├── docs/                   # 架构文档
├── DESIGN.md               # 设计系统规范
└── .suncode/               # 本地配置（git 忽略）
```

## 命令

| 命令 | 说明 |
|---|---|
| `bun run dev` | 启动 Vite + Electron 开发环境 |
| `bun run build` | 构建前端 + Electron |
| `bun run electron:build` | 打包可分发桌面应用 |
| `bun run test` | 运行 vitest 测试套件 |
| `bun run test:watch` | 监视模式 |
| `bun run test:coverage` | 测试覆盖率报告 |
| `bun run typecheck` | TypeScript 严格类型检查 |
| `bun run lint` | Biome 代码检查 |
| `bun run format` | Biome 代码格式化 |

## 子 Agent 系统

SunCode 支持将独立任务委托给专项子 Agent 并行执行：

```json
// 并行调用多个子 Agent
{
  "calls": [
    { "agent": "explore", "prompt": "扫描 src/ 的完整架构" },
    { "agent": "review", "prompt": "审查 ipc-handlers.ts 的错误处理" }
  ]
}
```

- **并发调度**：子 Agent 内部使用 `Promise.all()` 并行执行，受 CPU 核心数限制（最多 4 个并发）
- **深度守卫**：最大嵌套深度 3 层，防止无限递归
- **循环检测**：防止 A→B→A 的循环委托
- **流式输出**：实时显示子 Agent 的思考过程和工具调用
- **命名会话**：支持持久化会话，跨轮次共享上下文

内置子 Agent 定义在 `.suncode/agents/` 目录下。

## Prompt 缓存设计

System Prompt 按照 maka-agent 风格组织，最大化 Anthropic 的 Prompt Cache 命中率：

```
┌──────────────────────────────────────────┐
│ SECTION 1: 静态缓存前缀                    │ ← pi-ai 自动标记 cache_control
│   • 基础 System Prompt（永不变）           │
│   • Tool Usage Guidelines（永不变）        │
│   • Git Push Rule（永不变）               │
├──────────────────────────────────────────┤
│ SECTION 2: 半静态内容（每会话变化）          │
│   • Permission Mode / Environment        │
│   • Available Tools（无 Date 字段！）       │
├──────────────────────────────────────────┤
│ SECTION 3: 项目特定内容（尾部）              │
│   • Project Memory / agents.md / Skills  │
└──────────────────────────────────────────┘
```

同一会话内的多轮对话，静态前缀只需首次写入缓存（~125% 成本），后续每轮按 10% 读取。`cacheRetention: 'long'` 启用 1 小时 TTL。

## 技术栈

- **运行时**: Bun / Node.js 22
- **前端**: Vue 3、Pinia、Vite、CodeMirror 6
- **桌面**: Electron 34
- **AI SDK**: pi-ai（30+ 厂商，900+ 模型）
- **测试**: Vitest（借鉴 Kimi Code + pi 规范）
- **代码质量**: Biome（Lint + Format）

## 许可证

MIT
