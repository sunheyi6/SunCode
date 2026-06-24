# 子 Agent 架构设计调研

## 调研对象

| 项目 | 类型 | 仓库 |
|---|---|---|
| **pi-subagent** | Pi Agent 扩展 | https://github.com/mjakl/pi-subagent |
| **maka-agent** | Electron 桌面 Agent | https://github.com/jackwener/maka-agent |
| **Codex CLI** | OpenAI CLI Agent | https://github.com/openai/codex |

---

## 一、架构模型对比

```
┌─────────────────────────────────────────────────────────────────┐
│                    三大框架的核心差异                               │
├──────────────┬─────────────────┬─────────────────┬───────────────┤
│              │  pi-subagent    │  maka-agent      │  Codex CLI    │
│ 隔离级别      │ OS进程级         │ Electron会话级    │ 沙箱+工作树   │
│ 通信方式      │ stdin/stdout    │ 共享存储+IPC      │ MCP + JSON   │
│ 上下文策略     │ empty/parent    │ Session分片       │ 继承/隔离     │
│ 持久化        │ 命名Session      │ AgentRun Ledger  │ checkpoints  │
│ 最大并发      │ CPU核数-2        │ Session级别        │ max_threads:6│
│ 深度限制      │ 3层              │ 未明确限制         │ max_depth:1  │
└──────────────┴─────────────────┴─────────────────┴───────────────┘
```

---

## 二、通信机制详解

### 2.1 pi-subagent — 进程级隔离 + stdin/stdout 管道

```
Parent pi process                    Child pi process
  ┌──────────┐         fork          ┌──────────────────┐
  │ Main     │ ─────────────────────→│ pi --mode json    │
  │ Agent    │    stdin: task JSON    │ -p --no-session   │
  │          │←──────────────────────│                   │
  │          │   stdout: JSONL lines  │ Independent       │
  │          │                       │ model/tool loop   │
  └──────────┘                       └──────────────────┘
```

**关键设计：**

- 子进程通过 `pi --mode json -p --no-session` 启动，完全独立的模型和工具循环
- 任务通过 **stdin** 传入（非 CLI 参数），避免进程列表泄露和参数长度限制
- 结果通过 **stdout JSONL** 返回，父进程只接收**精简文本摘要**，不是完整执行追踪
- 父进程看到的只有：`✓ completed: Found auth entry points in src/auth/`
- 详细数据（工具调用、token 用量、session ID）保留在 result metadata 中供 TUI 渲染

### 2.2 maka-agent — 共享存储 + 事件溯源

```
┌──────────────────────────────────────────────────┐
│              SessionManager                       │
│  ┌─────────┐  ┌─────────┐  ┌─────────────────┐  │
│  │AgentRun │  │AgentRun │  │   AgentRun       │  │
│  │(turn 1) │  │(turn 2) │  │   (resume)       │  │
│  └────┬────┘  └────┬────┘  └───────┬─────────┘  │
│       │            │               │              │
│  ┌────▼────────────▼───────────────▼─────────┐   │
│  │        AgentRunStore (文件JSONL)            │   │
│  └───────────────────────────────────────────┘   │
│                                                   │
│  ┌───────────────────────────────────────────┐   │
│  │  AiSdkBackend → ModelAdapter → ToolRuntime│   │
│  └───────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

**关键设计：**

- `SessionManager` 是外部暴露的唯一公共 API
- `AgentRun` 是单次 turn 的**持久化运行事实**（durable run record）
- 所有 run 写入 `AgentRunStore`（文件 JSONL），启动时可恢复中断的运行
- `RunTrace` 是 best-effort 事件流，不允许 trace 写入失败影响对话
- `ToolRuntime` 承担权限校验、watchdog、abort、遥测、错误分类

### 2.3 Codex CLI — MCP 协议 + 工作树隔离

```
Orchestrator (main agent)
  │  MCP protocol (JSON-RPC / stdio)
  ▼
┌──────────────────────────┐
│  Codex MCP Server        │
│  (长期运行进程)            │
│                          │
│  ┌────────────────────┐  │
│  │  codex() tool      │  │──→ spawn worker
│  │  codex-reply()     │  │←── worker result
│  └────────────────────┘  │
└──────────────────────────┘
         │
    ┌────▼────┐  ┌──────────┐  ┌──────────┐
    │ Worker 1 │  │ Worker 2 │  │ Worker 3 │
    │ git WT 1 │  │ git WT 2 │  │ git WT 3 │
    └─────────┘  └──────────┘  └──────────┘
```

**关键设计 — "Never let multiple workers edit the same working tree simultaneously"：**

- 每个 worker 拥有独立的 git worktree 或 sandbox
- `codex exec --json <task>` 为每个任务启动独立进程
- Worker 产出 artifacts/patches 到 `outputs/<task_id>/`
- Supervisor 顺序验证并合并结果
- 只读 worker 可安全并行；写 worker 需文件系统隔离

---

## 三、防止注意力丢失的核心策略

### 3.1 问题根源

```
单一 agent 的上下文退化曲线：

  Agent 能力
  ↑
  │  ██
  │  ████
  │  ██████░░░░(注意力衰减开始)
  │  ████████░░░░░░
  │  ██████████░░░░░░░░░░░░(上下文污染)
  │  ████████████░░░░░░░░░░░░░░░░(目标丢失)
  └──────────────────────────→ 上下文长度

污染源：
  1. 大量文件读取的冗长输出
  2. 失败尝试的中间步骤
  3. 旧的工具调用结果
  4. 多轮对话的历史沉积
```

### 3.2 三大框架的策略对比

#### pi-subagent

| 策略 | 机制 |
|---|---|
| **上下文隔离** | 子 agent 以空上下文启动（`initialContext: "empty"`），只看到任务描述 |
| **输出截断** | 父 agent 只接收精简摘要，不含工具调用链、推理追踪 |
| **命名持久会话** | `session: "api-review"` 跨多轮保持上下文，但只在子 agent 侧 |
| **深度守卫** | `PI_SUBAGENT_DEPTH` 限制最大深度 3，防止递归爆炸 |
| **循环防护** | `PI_SUBAGENT_STACK` 追踪祖先 agent 名，阻止同名 agent 循环调用 |
| **Parallel fan-out** | 多个独立探索并行执行，由父 agent 聚合结果 |

#### maka-agent

| 策略 | 机制 |
|---|---|
| **Session 分片** | 每个对话是独立 session 文件，不跨 session 污染 |
| **AgentRun Ledger** | 每次运行写入持久化 ledger，可中断恢复 |
| **Turn 分支** | 可从 turn 分支回退到健康状态 |
| **权限引擎** | 工具调用走权限策略，控制行为边界 |
| **恢复逻辑** | 启动时扫描中断 session 自动恢复 |
| **模型适配器** | 隔离不同 provider 差异性，统一错误处理 |

#### Codex CLI

| 策略 | 机制 |
|---|---|
| **最大深度 1** | 默认只允许一层委托，强制扁平化 |
| **只读/读写分离** | Explorer agent（只读）与其他 agent 隔离 |
| **Gated handoff** | 上游产出文件后，PM agent 验证才解锁下游 |
| **自动压缩** | LRU 策略：85% 触发压缩，目标 70%，保留首尾 N 条 |
| **Trajectory watchers** | 可组合守卫：进度、预算、范围、委托提醒 |
| **30 分钟超时** | 硬超时兜底防止死循环 |
| **Artifact-based 传递** | agent 间传递文件路径而非完整上下文 |

---

## 四、SunCode 推荐架构

### 4.1 设计原则

融合三者优点，发挥 Electron + Vue 3 + Worker Thread 架构优势：

```
              ┌──────────────┐
              │  Main Agent   │  ← 高层规划 + 用户交互
              │  (Orchestrator)│
              └──┬────────┬──┘
                 │        │
         ┌───────▼──┐ ┌──▼────────┐
         │Explorer   │ │ Implementer│  独立 Worker Thread 内逻辑沙箱
         │(readonly) │ │(sandboxed)│  (非 OS 进程，零开销)
         └───────────┘ └───────────┘
              │              │
         ┌────▼──────────────▼───┐
         │   SunCode Worker      │
         │   (agent-worker.ts)   │  ← 已有基础设施
         │   + subagent dispatch │
         └───────────────────────┘
```

### 4.2 与三大框架的差异与优势

| 维度 | pi-subagent | maka-agent | Codex CLI | **SunCode** |
|---|---|---|---|---|
| **运行载体** | OS 进程 | Electron 会话 | 独立进程+git WT | **Worker Thread** |
| **每次调用开销** | ~300ms | ~50ms | ~500ms | **~30ms** |
| **上下文隔离** | 完全进程隔离 | Session 文件分片 | 文件系统隔离 | **逻辑上下文沙箱** |
| **并发模型** | fork+pipe | turn 串行 | MCP 异步 | **线程池+AbortSignal** |
| **状态传递** | stdin/stdout | AgentRunStore | artifacts 文件 | **Pinia store+IPC** |
| **UI 渲染** | TUI 文本流 | React 组件 | CLI 文本流 | **Vue 3 组件流** |
| **持久化恢复** | 命名 Session | Ledger JSONL | checkpoints | **RunEvent JSONL** |
| **工具权限** | tools 字段白名单 | 权限引擎 | sandbox_mode | **工具注册表+role** |
| **类型安全** | 动态 JSON | 部分 typed | TOML 配置 | **全链路 TS 类型** |

### 4.3 独有优势

1. **零开销快速探索** — Thread 级别隔离，30ms 启动 vs pi-subagent 300ms
2. **统一 Vue 组件渲染管道** — 子 agent 工具调用复用 ToolCard/StreamingText/FilePreview
3. **全链路 TypeScript 类型** — 子 agent 定义 → 工具注册 → IPC → Store → UI 全程类型安全
4. **Reactivity-first 状态管理** — Pinia store 驱动，StatusBar 实时显示子 agent 进度
5. **与现有基础设施零摩擦** — RunEvent 自动记录、Token 统计按 agent 拆分、Recovery 自动恢复

### 4.4 SunCode 已有基础设施复用

| 现有能力 | 映射到子 Agent |
|---|---|
| `Worker Thread` (agent-worker.ts) | 子 agent 运行环境 |
| `RunEvent` JSONL (run-store.ts) | AgentRun Ledger |
| `Session` 持久化 (session-store.ts) | 命名持久会话 |
| `Tool` 接口 (tools/types.ts) | 子 agent 工具白名单 |
| `Recovery` (recovery.ts) | 启动恢复中断任务 |
| `AbortController` | 超时/取消级联传播 |
| `TokenUsageSummary` (stats) | 按 agent 拆分成本 |

### 4.5 需要新增的能力

1. **子 Agent 调度器** — 在 agent-worker 内管理多个并发子任务
2. **上下文隔离** — 子 agent 只接收任务描述 + 必要上下文
3. **深度守卫 + 循环检测** — 环境变量追踪委托栈
4. **输出摘要化** — 子 agent 返回精简结果
5. **工具白名单** — 每个子 agent 只能使用指定工具集

---

## 五、参考来源

- [pi-subagent](https://github.com/mjakl/pi-subagent) — MIT License
- [maka-agent](https://github.com/jackwener/maka-agent) — 本地优先桌面 AI 工作台
- [Codex CLI](https://github.com/openai/codex) — Apache-2.0 License
- [Codex Subagents 文档](https://developers.openai.com/codex/subagents)
