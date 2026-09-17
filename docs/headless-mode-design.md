# 无头模式设计

日期: 2026-09-17 | 状态: 已实现

---

## 概述

无头模式（headless）**不启动 Electron / 不开窗口**，直接复用 worker 侧的 `runAgentLoop` 与同一套 Agent 机制，用于把 SunCode 跑在评测基准（Harbor / Terminal-Bench / DeepSwe）与自动化脚本里。

它与桌面版共享同一条 Agent 循环，差别只在**宿主与工具执行位置**：桌面版的工具在本机工作区执行，无头模式的工具可以经 HTTP 桥接进 benchmark 容器内执行。

**核心原则：**

- **同一 Agent 机制**：无头路径复用 `runAgentLoop`、Stop Hooks、工具注册，不另起一套实现
- **工具位置可桥接**：本机执行或经 HTTP 桥进容器，对 Agent 透明
- **结果落盘**：cell-output 与运行日志写在挂载目录，供评测框架回收

---

## 两种运行模式

| 维度 | Electron UI 模式 | 无头模式 |
|---|---|---|
| 入口 | Renderer ↔ Main(contextBridge) ↔ Worker | host cell 脚本直接跑 AgentLoop |
| 工具执行 | 本机工作区 | 本机或经 HTTP 桥进容器 |
| 输出 | 流式上屏 | 写 `cell-output.json` / 运行日志 |
| 典型用途 | 日常编码 | 基准测试、CI |

---

## 入口

| 入口 | 角色 |
|---|---|
| `scripts/run-suncode-harbor-loop.ts` | **首选生产路径**：复用共享 `runAgentLoop`，由 `harbor/suncode_agent.py` 以 bun 拉起 |
| `harbor/run-suncode-host-cell.mjs` | legacy/simple 路径：不共享 AgentLoop，直接调 pi-ai 的 `completeSimple`，工具转发到容器 |
| `harbor/suncode_agent.py` | Harbor 适配器：实现 `BaseInstalledAgent`，启动 host cell 并在宿主侧跑 HTTP 桥 |

`run-suncode-harbor-loop.ts` 还装配了 `createDefaultStopHookRegistry()`、模型注册表与自定义工具（`BaseTool`），保证无头路径与桌面版行为一致。

---

## HTTP 工具桥

无头模式下，容器内的工具执行由宿主侧 HTTP 服务代理：

- 适配器（`suncode_agent.py`）用 `ThreadingHTTPServer` 起一个 `_ToolExecutorServer`，把宿主与容器参数转成桥接令牌
- 宿主侧 host cell 用 `RemoteExecutor.exec(command, timeoutMs)` 发请求，拿回 `{ stdout, stderr, exitCode }`
- 宿主 Node 进程的环境变量经白名单透传（`_HOST_NODE_ENV_ALLOWLIST`：PATH / TMPDIR / SSL_CERT_* / SystemRoot / HTTP_PROXY …），避免把宿主机密带进容器

---

## 环境变量

host cell 通过环境变量接收配置（由 `suncode_agent.py` 注入）：

| 变量 | 用途 |
|---|---|
| `SUNCODE_INSTRUCTION_FILE` | 任务指令文件路径 |
| `SUNCODE_OUTPUT_DIR` | 输出目录（写 `cell-output.json`） |
| `SUNCODE_STORAGE_ROOT` | 临时存储根目录 |
| `SUNCODE_WORKDIR` | 容器内工作目录 |
| `SUNCODE_HARBOR_TOOL_EXECUTOR_URL` | HTTP 桥地址 |
| `SUNCODE_HARBOR_TOOL_EXECUTOR_TOKEN` | HTTP 桥 Bearer 令牌 |
| `SUNCODE_MODEL` / `SUNCODE_PROVIDER` | 模型与厂商 |
| `SUNCODE_SYSTEM_PROMPT` | 可选的 system prompt 覆盖 |

---

## 基准脚本

| 脚本 | 目标 |
|---|---|
| `scripts/run-terminal-bench.ts` | Harbor Terminal-Bench（`harbor run -d terminal-bench/terminal-bench-2 -a suncode_agent:SunCodeAgent`） |
| `scripts/run-terminal-bench-ab.ts` | Terminal-Bench A/B（压缩策略对照） |
| `scripts/run-deep-swe.ts` | DeepSwe / Pier（`pier_suncode_agent:SunCodeAgent`） |
| `harbor/trial_pricing.py` | 试验成本核算 |

Terminal-Bench 运行器会为 `SunCodeAgent` 追加 `--agent-env`：`SUNCODE_REPO_ROOT` / `SUNCODE_PROVIDER` / `SUNCODE_MODEL` / `SUNCODE_CUSTOM_ENDPOINTS_B64` / `SUNCODE_SETTINGS_PATCH_B64` 及厂商 API key。条目里 `bun run test:deep-swe` / `bun run test:terminal-bench` 即走这条路。

---

## 关键约束

1. **不启动 UI** — 无头路径不依赖 Electron 与桌面会话
2. **机制同源** — 复用 `runAgentLoop` / Stop Hooks / 工具注册，避免双实现漂移
3. **工具位置透明** — 本机与容器桥接对 Agent 无感
4. **环境白名单** — 仅透传必要宿主环境变量，防止密钥外泄

---

## 相关源码

| 模块 | 路径 |
|---|---|
| 无头 host cell（首选） | `scripts/run-suncode-harbor-loop.ts` |
| 无头 host cell（legacy） | `harbor/run-suncode-host-cell.mjs` |
| Harbor 适配器 | `harbor/suncode_agent.py` |
| Terminal-Bench 运行器 | `scripts/run-terminal-bench.ts` / `scripts/run-terminal-bench-ab.ts` |
| DeepSwe 运行器 | `scripts/run-deep-swe.ts` / `pier_suncode_agent.py` |
| 共享 Agent 循环 | `src/worker/agent/agent-loop.ts` |
| 设置补丁解码 | `scripts/terminal-bench-settings.ts` |
