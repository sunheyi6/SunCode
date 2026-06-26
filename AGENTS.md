## Repository Guidelines

### Project Structure & Module Organization

SunCode is an Electron desktop application built with Vue 3 and TypeScript.

- `src/main/` contains the Electron main process, preload bridge, menus, windows, and IPC handlers.
- `src/renderer/` contains the Vue UI. Keep reusable UI in `components/`, state in `stores/`, and shared behavior in `composables/`.
- `src/worker/` implements the coding agent, model/MCP integrations, tools, and worker-thread entry point.
- `src/shared/` holds types and constants shared across process boundaries.
- `scripts/` contains standalone diagnostics; `docs/` contains architecture notes; `resources/` contains packaged assets.
- `dist/` and `dist-electron/` are generated output and should not be edited manually.

### Build, Test, and Development Commands

Use Bun for dependency and script execution (Node.js 22+ is required).

- `bun install` installs dependencies from `bun.lock`.
- `bun run dev` starts Vite and the Electron development process with reload support.
- `bun run build` creates renderer and Electron bundles.
- `bun run electron:build` builds distributable desktop packages with electron-builder.
- `bun run typecheck` runs strict TypeScript validation.
- `bun run lint` checks `src/` with Biome.
- `bun run format` rewrites supported source files using Biome.
- `bun run test:ai` performs a live provider smoke test using `.suncode/config.json`.

### Coding Style & Naming Conventions

Biome enforces 2-space indentation, single quotes, semicolons, trailing commas, and a 100-character line width. Use `PascalCase.vue` for components, `useX.ts` for composables, and descriptive `kebab-case.ts` names for modules. Prefer `camelCase` for functions/variables and `PascalCase` for types and classes. Use the `@/` and `@shared/` aliases instead of long relative imports. Keep IPC payloads explicitly typed in `src/shared/types.ts`.

### Testing Guidelines

No unit-test framework or coverage threshold is currently configured. Before submitting changes, run `bun run typecheck`, `bun run lint`, and `bun run build`. Manually exercise affected Electron flows. Add future tests beside their modules as `*.test.ts`; mock external model and MCP calls unless an integration test explicitly requires credentials.

### Commit & Pull Request Guidelines

**CRITICAL: 提交必须由用户明确指示。** 不得在用户未明确说"提交"/"commit"/"push"等指令时自动执行 git add、git commit 或 git push。完成代码修改后，仅报告结果，等待用户指示是否提交。

Use concise Conventional Commit messages such as `feat(renderer): add model filter` or `fix(worker): handle aborted tool calls`. Pull requests should explain user-visible behavior, list verification commands, link relevant issues, and include screenshots for UI changes. Keep generated bundles and local `.suncode/` secrets out of review.

### Security & Configuration

Never commit API keys or personal configuration. Treat `.suncode/config.json` as local-only, redact credentials from logs, and validate all data crossing preload, IPC, tool, and MCP boundaries.

### Design Documentation

Design documents live in `docs/*.md`. They describe the *current* architecture, not planned features (those go in `docs/superpowers/`).

**Implementation-first constraint:**
- Key design details MUST be implemented first, then documented.
- Never write a design doc describing something that doesn't exist yet in code.
- When adding a new design doc or updating an existing one, the corresponding code change must already be in the working tree.
- This prevents documentation drift and ensures docs always reflect reality.

**Design doc recording discipline:**
- After implementing a non-trivial feature or making a key design decision, record a design doc in `docs/` by default.
- Judge whether to create a new file or append to an existing one based on the functional area:
  - New independent feature → create `docs/<feature-name>.md`.
  - Extension or refinement of an existing feature → update the existing doc.
  - Cross-cutting concern (e.g. context budget, IPC protocol) → create or update a dedicated doc.
- Design docs must be written immediately after the code change, before moving on to the next task.

**Design doc synchronization rule:**
- When you modify code that is covered by an existing design doc in `docs/`, you MUST update the corresponding design doc in the same commit batch.
- This includes: architecture changes, new design decisions, bug fixes that change behavior, addition/removal of modules, interface changes, and lessons learned.
- If you are unsure which design doc covers a file, grep `docs/` for the file path or the module name.
- A design doc update can be as small as adding a bullet point to "Lessons Learned" or updating a flow diagram — the key is that docs never drift from code.
- This rule applies to ALL code changes, not just new features. Bug fixes that reveal design flaws are especially important to document.

**Design doc structure:**
1. Problem / design goal
2. Architecture (diagrams, data flow)
3. Implementation details (code excerpts, key types)
4. Design decisions and trade-offs
5. Lessons learned (effective practices and anti-patterns)

**Design doc index** (current as of last commit):

| 文档 | 覆盖范围 |
|------|----------|
| `docs/system-prompt-design.md` | 系统提示词的三层缓存布局、权限模式、工具片段注入 |
| `docs/tool-calling-design.md` | 工具注册、并行执行、JSON Schema、MCP 集成 |
| `docs/context-compaction-design.md` | 三层上下文预算（stale prune / turn cap / history compact） |
| `docs/subagent-architecture-comparison.md` | 子 Agent 调度、深度守卫、循环检测、沙箱隔离 |
| `docs/task-completion-mechanism.md` | `needs_follow_up` 决策、`/goal` 自主循环、Stop Hooks |
