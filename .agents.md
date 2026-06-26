# SunCode

## 项目约束

- 开发服务器端口固定 `5173`，`strictPort: true`，禁止切换端口
- 启动命令 `npm run dev`，访问 `http://localhost:5173/`
- 代码风格遵循已有模式，不引入新范式
- TypeScript strict 模式，禁止 `any` 除非有注释说明
- 所有输出使用用户语言，中文对话用中文思考

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
