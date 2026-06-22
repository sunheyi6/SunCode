# SunCode

AI-powered desktop coding agent client built with **Electron + Vue 3 + TypeScript**.

## Features

- 🤖 Multi-provider AI models (DeepSeek, Anthropic, OpenAI, Google, xAI, and more)
- 🛠 Built-in tools: bash, read, write, edit, grep, glob
- 📊 Live tool operation cards showing file edits (+/- lines) and command output
- 💾 Session persistence with chat history
- 🔌 MCP (Model Context Protocol) server support
- 🌓 Catppuccin light/dark themes
- 🧠 Agent reasoning with streaming output

## Prerequisites

- **Node.js** >= 22
- **Bun** (package manager and runtime)

## Quick Start

```bash
# Install dependencies
bun install

# Start development
bun run dev

# Build for production
bun run build

# Build Electron distributable
bun run electron:build
```

## Project Structure

```
SunCode/
├── src/
│   ├── main/          # Electron main process, IPC handlers
│   ├── preload/       # Context bridge
│   ├── renderer/      # Vue 3 UI
│   │   ├── components/ # UI components
│   │   │   ├── chat/   # Chat panel, messages
│   │   │   └── tools/  # Tool operation cards
│   │   ├── stores/     # Pinia stores
│   │   ├── composables/# Vue composables
│   │   └── utils/     # Presentation helpers
│   ├── worker/        # Agent worker thread
│   │   ├── agent/     # Agent loop, system prompt
│   │   ├── tools/     # Built-in tool implementations
│   │   ├── models/    # Model registry
│   │   └── mcp/       # MCP client
│   └── shared/        # Types and constants
├── scripts/           # Standalone scripts
├── docs/              # Architecture docs
└── .suncode/          # Local config (gitignored)
```

## Scripts

| Command | Description |
|---|---|
| `bun run dev` | Start Vite + Electron dev server |
| `bun run build` | Build renderer + Electron bundles |
| `bun run electron:build` | Package distributable desktop app |
| `bun run test` | Run all Bun tests |
| `bun run typecheck` | TypeScript strict type check |
| `bun run lint` | Biome linter |
| `bun run format` | Biome formatter |

## Tech Stack

- **Runtime**: Bun / Node.js 22
- **Frontend**: Vue 3, Pinia, Vite
- **Desktop**: Electron 34
- **AI SDK**: pi-ai, OpenAI SDK, Anthropic SDK
- **Testing**: Bun test
- **Linting**: Biome

## License

MIT
