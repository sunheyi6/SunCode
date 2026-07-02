# SunCode

## 项目约束

- 开发服务器端口固定 `5173`，`strictPort: true`，禁止切换端口
- 启动命令 `bun run dev`。`dev` 实际由 `scripts/launch-dev.js` 启动器接管，它会检查依赖完整性、适配无 TTY / CI 环境，并拒绝在无桌面会话时启动 Electron。
- `bun run dev` 为长期运行服务，后台执行即可。启动后**禁止**额外读取日志文件或 cat 输出做二次确认，窗口弹出即为成功
- 代码风格遵循已有模式，不引入新范式
- TypeScript strict 模式，禁止 `any` 除非有注释说明
- 所有输出使用用户语言，中文对话用中文思考
- **第一性原理思考**：遇到问题时，先追问根因，从源头解决，而非在下游打补丁。如果发现自己在同一个问题域反复修改，说明没有找对层次——向上游走一步，胜过向下游走十步
- **代码为真**：以实际代码为准理解实现，不盲信文档、注释或 AI 生成的描述。修改前先读相关代码确认当前状态；除非用户明确要求，否则不要阅读普通 Markdown 来理解实现
- 代码变更前先阅读相关代码和最近的约束，遵循目录树中最近的 AGENTS.md
- **改动聚焦**：一次只做一件事，不附带无关重构。如果发现需要重构的部分超出了当前任务范围，记录下来但不在本次改动中处理
- **先澄清再动手**：需求不明确时主动询问，不要猜测用户意图后直接执行
- `undefined` 直接传递，不要用条件展开 `...(x ? { y } : {})`
- 可选属性不需要显式标注 `| undefined`
- 只有单个参数的内部方法不应为了风格统一而转为选项对象
- 除了包的 `index.ts`，其他 `index.ts` 文件应优先使用 `export * from './module';`
- 核心类应可独立使用，构造函数不应强制依赖外部生命周期对象
- 不要添加太多新测试文件，优先添加到现有测试文件
- 测试失败时，默认先修复测试；除非实现真有bug，否则不要改变实现以满足旧测试
- 测试应验证行为而非特定输出字符串/文案，避免因提示词迭代或错误消息格式变化导致测试失效
- 返回值结构扩展（新增字段）时需同步更新测试，使用 `toMatchObject` 而非 `toEqual` 检查核心字段
- 不要为外部兼容性牺牲代码质量，破坏性变更通过 changesets 和 `major` 版本升级处理
- 提交时不添加共同作者，不在提交信息、PR描述或说明文本中暴露 agent 身份
- 保持 AGENTS.md 和 CLAUDE.md 内容一致，同步更新
- 复合指令（如"对比 X 和 Y 保证一致"）应包含执行，文件不一致时主动同步无需等待确认
- DeepSwe/Pier 基准测试统一使用 `bun run test:deep-swe -- <task-id-or-path>`，不要手写 `pier run` 长命令；默认从 `../deep-swe/tasks/<task-id>` 解析任务，也可用 `DEEP_SWE_ROOT` 或 `--deep-swe-root` 指定根目录

## 诊断日志

| 日志类型 | 路径 |
|----------|------|
| 主进程日志 | `%APPDATA%\SunCode\.suncode\app.log`（自动轮转，≥2MB → `app.old.log`） |
| Agent 运行时诊断 | `%APPDATA%\SunCode\.suncode\diagnostics\<runId>.log`（每次运行独立文件） |
| 运行事件 | `%APPDATA%\SunCode\.suncode\sessions\<sessionId>\runs\<runId>.jsonl`（每次运行独立 JSONL 文件） |
| Bash 后台输出（harness 层） | `%USERPROFILE%\.zcode\cli\exec\sess_{sessionId}\call_{callId}-stdout.log` |

## 构建与发布

- `bun run electron:build` 本地打包当前平台
- 推送 `v*` 格式 tag 触发 GitHub Actions 三平台构建
- 构建产物：Windows `.exe` (NSIS + Portable)、macOS `.dmg` (arm64)、Linux `.AppImage` + `.deb`

## 架构约定

- Electron Main → Worker Thread → Agent → AgentLoop 单向依赖
- IPC 通信：Renderer ↔ Main (contextBridge) ↔ Worker (postMessage)
- 工具实现 `Tool` 接口，标记 `isReadonly` 控制权限
- 权限模式：`plan`（只读工具）| `confirm_changes`（弹窗确认）| `auto_edit` | `full_access`
- 会话按 `workingDirectory` 分组，切换会话时同步 Worker 工作目录
