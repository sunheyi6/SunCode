# Repository Guidelines

## Project Structure & Module Organization

SunCode is an Electron desktop application built with Vue 3 and TypeScript.

- `src/main/` contains the Electron main process, preload bridge, menus, windows, and IPC handlers.
- `src/renderer/` contains the Vue UI. Keep reusable UI in `components/`, state in `stores/`, and shared behavior in `composables/`.
- `src/worker/` implements the coding agent, model/MCP integrations, tools, and worker-thread entry point.
- `src/shared/` holds types and constants shared across process boundaries.
- `scripts/` contains standalone diagnostics; `docs/` contains architecture notes; `resources/` contains packaged assets.
- `dist/` and `dist-electron/` are generated output and should not be edited manually.

## Build, Test, and Development Commands

Use Bun for dependency and script execution (Node.js 22+ is required).

- `bun install` installs dependencies from `bun.lock`.
- `bun run dev` starts Vite and the Electron development process with reload support.
- `bun run build` creates renderer and Electron bundles.
- `bun run electron:build` builds distributable desktop packages with electron-builder.
- `bun run typecheck` runs strict TypeScript validation.
- `bun run lint` checks `src/` with Biome.
- `bun run format` rewrites supported source files using Biome.
- `bun run test:ai` performs a live provider smoke test using `.suncode/config.json`.

## Coding Style & Naming Conventions

Biome enforces 2-space indentation, single quotes, semicolons, trailing commas, and a 100-character line width. Use `PascalCase.vue` for components, `useX.ts` for composables, and descriptive `kebab-case.ts` names for modules. Prefer `camelCase` for functions/variables and `PascalCase` for types and classes. Use the `@/` and `@shared/` aliases instead of long relative imports. Keep IPC payloads explicitly typed in `src/shared/types.ts`.

## Testing Guidelines

No unit-test framework or coverage threshold is currently configured. Before submitting changes, run `bun run typecheck`, `bun run lint`, and `bun run build`. Manually exercise affected Electron flows. Add future tests beside their modules as `*.test.ts`; mock external model and MCP calls unless an integration test explicitly requires credentials.

## Commit & Pull Request Guidelines

Git history is unavailable in this checkout, so use concise Conventional Commit messages such as `feat(renderer): add model filter` or `fix(worker): handle aborted tool calls`. Pull requests should explain user-visible behavior, list verification commands, link relevant issues, and include screenshots for UI changes. Keep generated bundles and local `.suncode/` secrets out of review.

## Security & Configuration

Never commit API keys or personal configuration. Treat `.suncode/config.json` as local-only, redact credentials from logs, and validate all data crossing preload, IPC, tool, and MCP boundaries.
