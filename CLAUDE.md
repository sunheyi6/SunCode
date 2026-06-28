# SunCode

## 项目约束

- 开发服务器端口固定 `5173`，`strictPort: true`，禁止切换端口
- 启动命令 `npm run dev`，Electron 窗口自动打开（桌面应用，不是网页）。`npm run dev` 为长期运行服务，后台执行即可。启动后**禁止**额外读取日志文件或 cat 输出做二次确认，窗口弹出即为成功
- 代码风格遵循已有模式，不引入新范式
- TypeScript strict 模式，禁止 `any` 除非有注释说明
- 所有输出使用用户语言，中文对话用中文思考
- **第一性原理思考**：遇到问题时，先追问根因，从源头解决，而非在下游打补丁。如果发现自己在同一个问题域反复修改，说明没有找对层次——向上游走一步，胜过向下游走十步
- **代码为真**：以实际代码为准理解实现，不盲信文档、注释或 AI 生成的描述。修改前先读相关代码确认当前状态
- **改动聚焦**：一次只做一件事，不附带无关重构。如果发现需要重构的部分超出了当前任务范围，记录下来但不在本次改动中处理
- **先澄清再动手**：需求不明确时主动询问，不要猜测用户意图后直接执行
- `undefined` 直接传递，不要用条件展开 `...(x ? { y } : {})`
- 可选属性不需要显式标注 `| undefined`
- 保持 AGENTS.md 和 CLAUDE.md 内容一致，同步更新
- 复合指令（如"对比 X 和 Y 保证一致"）应包含执行，文件不一致时主动同步无需等待确认

## 诊断日志

| 日志类型 | 路径 |
|----------|------|
| 主进程日志 | `%APPDATA%\SunCode\.suncode\app.log`（自动轮转，≥2MB → `app.old.log`） |
| Agent 运行时诊断 | `%APPDATA%\SunCode\.suncode\diagnostics\<runId>.log`（每次运行独立文件） |
| 运行事件 | `%APPDATA%\SunCode\.suncode\run-events\` |
| Bash 后台输出（harness 层） | `%USERPROFILE%\.zcode\cli\exec\sess_{sessionId}\call_{callId}-stdout.log` |

## 构建与发布

- `npm run electron:build` 本地打包当前平台
- 推送 `v*` 格式 tag 触发 GitHub Actions 三平台构建
- 构建产物：Windows `.exe` (NSIS + Portable)、macOS `.dmg` (arm64)、Linux `.AppImage` + `.deb`

## 架构约定

- Electron Main → Worker Thread → Agent → AgentLoop 单向依赖
- IPC 通信：Renderer ↔ Main (contextBridge) ↔ Worker (postMessage)
- 工具实现 `Tool` 接口，标记 `isReadonly` 控制权限
- 权限模式：`plan`（只读工具）| `confirm_changes`（弹窗确认）| `auto_edit` | `full_access`
- 会话按 `workingDirectory` 分组，切换会话时同步 Worker 工作目录
