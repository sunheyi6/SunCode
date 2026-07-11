/** Application name */
export const APP_NAME = 'SunCode';

/** Default settings */
export const DEFAULT_SETTINGS = {
  activeModel: 'deepseek-v4-pro',
  activeProvider: 'deepseek',
  thinkingLevel: 'low' as const,
  maxTurns: 200,
  autoCompact: true,
  compactThreshold: 0.7,
  theme: 'system' as const,
  permissionMode: 'full_access' as const,
  windowsShell: 'auto' as const,
  planApprovalMode: 'interactive' as const,
  fontSize: 14,
  mcpServers: [],
  skills: [],
  disabledSkills: [],
  envApiKeys: {},
  customEndpoints: [],
  goalMaxTurns: 5,
  goalMaxWallTimeMs: 600000, // 10 minutes
  maxLessons: 200,
  taskCompleteNotification: 'never' as const,
  createGitWorktree: false,
};

/** Curated list of recommended models for coding tasks. */
export const RECOMMENDED_MODELS: Array<{ provider: string; model: string; label: string }> = [
  { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { provider: 'anthropic', model: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { provider: 'openai', model: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
  { provider: 'openai', model: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { provider: 'openai', model: 'o4-mini', label: 'o4 Mini' },
  { provider: 'google', model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { provider: 'google', model: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite' },
  { provider: 'deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { provider: 'deepseek', model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { provider: 'xai', model: 'grok-code-fast-1', label: 'Grok Code Fast' },
  { provider: 'xai', model: 'grok-4.3', label: 'Grok 4.3' },
  { provider: 'mistral', model: 'mistral.mistral-large-3-675b-instruct', label: 'Mistral Large 3' },
  {
    provider: 'groq',
    model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    label: 'Llama 4 Maverick',
  },
  { provider: 'openrouter', model: 'openai/gpt-5.1-codex', label: 'GPT-5.1 Codex (OpenRouter)' },
  {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5 (OpenRouter)',
  },
];

/**
 * Lightweight/cheap model to use for short auxiliary tasks like session title
 * generation. Kept on the active provider so the user's API key is reused.
 * Falls back to the active model when no mapping exists.
 */
export const LITE_MODELS: Record<string, string> = {
  deepseek: 'deepseek-v4-flash',
  anthropic: 'claude-haiku-4-5',
  openai: 'o4-mini',
  google: 'gemini-3.1-flash-lite-preview',
  xai: 'grok-code-fast-1',
  groq: 'meta-llama/llama-4-scout-17b-128e-instruct',
  mistral: 'mistral.mistral-small-3-1-24b-instruct',
  openrouter: 'google/gemini-3.1-flash-lite-preview',
};

/** Default system prompt template */
export const DEFAULT_SYSTEM_PROMPT = `You are SunCode, an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.

## Guidelines
- Be concise in your responses
- Show file paths clearly when working with files
- Read files before editing
- Analyze root cause before fixing bugs
- Use tools in parallel when independent

## Task Planning
- For multi-step tasks (3+ distinct steps), output a plan using this format:

  📋 执行计划�?  - [ ] Step 1: Brief description
  - [ ] Step 2: Brief description

- Mark steps done with [x] and update progress with 📋 进度更新：as you work.
- The plan is shown to the user in real-time �?keep steps clear and specific.

## Delegation
- Delegate cross-directory searches (3+ files) to sub-agents
- Single file reads or simple greps: do yourself
- Keep exploration and modification separate

## /goal autonomous mode
Loops until goal is met or budget exhausted. --verify sets verification command, exit 0 = done. Act without waiting for confirmation.

## Code style
Follow existing project conventions. Minimize changes. Use descriptive names.

## Background process startup detection
Use background mode intentionally:
- finite background command: \`run_in_background: true\`
- long-running dev server/desktop app: \`run_in_background: true\` and \`background_mode: "service"\`
When starting a project service, use readiness evidence such as its normal startup output or reachable ports.

**CRITICAL RULES:**
1. **First, determine the project type** �?read package.json scripts to find the standard start command (\`npm run dev\`, \`npm start\`, etc.). Always use that command. Never manually invoke the underlying bundler or runtime (\`npx electron .\`, \`node server.js\`, etc.) unless the project has no npm scripts.
2. **Pick the right marker from this table** based on what bundler/runtime the dev script uses. Do NOT invent project-specific markers unless the target project's own code prints them.
3. **Never run GUI apps in foreground mode** �?they don't exit and will hang the tool forever. Always use \`run_in_background: true\` with \`background_mode: "service"\` for dev servers and desktop apps.
4. **Never verify background startup by global process name**. Commands like \`Get-Process -Name electron\`, \`tasklist | findstr electron\`, or \`ps aux | grep electron\` can match unrelated existing processes. If you need to check whether the launcher shell is still alive, use the exact PID returned by the background command, e.g. \`Get-Process -Id <pid>\`. App readiness still requires a project-specific marker, reachable port, visible window, or other direct app evidence.
5. **Let the bash tool wait for slow service readiness**. When a known log line exists, pass \`startup_marker\` and a suitable \`readiness_timeout\`. For slow Electron apps with no project-specific marker, pass \`readiness_timeout\` so the tool watches output/process lifetime before returning; if it still cannot confirm readiness, report that clearly instead of trying alternate manual launch commands.

| Bundler/Runtime | startup_marker | Example log line |
|---|---|---|
| Vite | "ready in" | "VITE v6.0.0  ready in 300ms" |
| Next.js | "Ready in" | "�?Ready in 2.5s" |
| webpack-dev-server | "compiled successfully" | "webpack compiled successfully" |
| Electron desktop app | no generic marker | use \`readiness_timeout\`, visible window evidence, or process CommandLine/AppPath evidence |
| Spring Boot | "Started " | "Started AppName in 5.2s" |
| Django | "Starting development server at" | "Starting development server at http://..." |
| Express/Fastify | "Server running on port" | common pattern |
| Flask | "Running on http://" | "Running on http://127.0.0.1:5000" |

If none of these match and the project has no built-in marker, fall back to \`expected_ports\`.`;

/** Prompt used to generate a concise session title from the first user message. */
export const TITLE_GENERATION_PROMPT = `Generate a concise title for this coding session.

Rules:
- Use the user's primary language.
- Use 3-7 words when possible.
- Keep it recognizable in a session list.
- Preserve important proper nouns, file names, APIs, and technology names.
- Do not use markdown, numbering, quotes, trailing punctuation, or explanations.
- Return only JSON in this shape: {"title":"..."}`;

/** Maximum number of turns before forcing a stop */
export const MAX_TURNS = 100;

/** Token estimation: rough chars per token */
export const CHARS_PER_TOKEN = 4;

/** Context window safety margin (don't use more than this fraction) */
export const CONTEXT_SAFETY_MARGIN = 0.9;

// ===== Lesson Defaults =====

/** 默认最大教训条�?*/
export const DEFAULT_MAX_LESSONS = 200;

// ===== Context Budget Defaults =====

/** Default max estimated tokens for a single tool result before pruning. */
export const DEFAULT_MAX_TOOL_RESULT_TOKENS = 2048;

/** Default number of recent turns whose tool results are kept intact. */
export const DEFAULT_MIN_RECENT_TURNS_FULL = 1;

/** Default minimum recent turns to always retain. */
export const DEFAULT_MIN_RECENT_TURNS = 2;

/** Default ratio of context window that triggers history compaction. */
export const DEFAULT_HIGH_WATER_RATIO = 0.8;

/** Default number of recent turns to keep after history compaction. */
export const DEFAULT_KEEP_RECENT_TURNS = 3;

/** Default context budget policy (used when autoCompact is enabled). */
export const DEFAULT_CONTEXT_BUDGET_POLICY = {
  staleToolResultPrune: {
    enabled: true,
    maxResultTokens: DEFAULT_MAX_TOOL_RESULT_TOKENS,
    minRecentTurnsFull: DEFAULT_MIN_RECENT_TURNS_FULL,
  },
  historyCompact: {
    enabled: true,
    highWaterRatio: DEFAULT_HIGH_WATER_RATIO,
    keepRecentTurns: DEFAULT_KEEP_RECENT_TURNS,
  },
  snip: {
    enabled: true,
    minResultChars: 500,
    maxAgeTurns: 3,
  },
  contextCollapse: {
    enabled: true,
    collapseThreshold: 0.7,
    maxGroupTokens: 4096,
  },
  minRecentTurns: DEFAULT_MIN_RECENT_TURNS,
  charsPerToken: CHARS_PER_TOKEN,
} as const;

// ===== Plan Mode Defaults =====

/** Default directory for plan files. */
export const DEFAULT_PLAN_DIR = '.suncode/plans';

/** Maximum turns in plan mode before requiring user to exit or approve. */
export const DEFAULT_PLAN_MAX_TURNS = 25;

// ===== Tool Execution Defaults =====

/** Default per-tool execution timeout in milliseconds (120s).
 *  Prevents hanging commands (e.g., `go build ./...` downloading deps)
 *  from blocking the agent loop indefinitely. */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

// ===== Error Recovery Defaults =====

/** Maximum retry attempts for max_output_tokens recovery. */
export const DEFAULT_MAX_OUTPUT_RECOVERY_ATTEMPTS = 3;

/** Maximum retry attempts for context overflow recovery. */
export const DEFAULT_CONTEXT_OVERFLOW_RECOVERY_ATTEMPTS = 2;

/** Escalated max_output_tokens value for recovery (32K). */
export const RECOVERY_MAX_OUTPUT_TOKENS = 32768;

/** Default max turns for a goal-level loop. */
export const DEFAULT_GOAL_MAX_TURNS = 5;

/** Default max wall time for a goal (10 minutes). */
export const DEFAULT_GOAL_MAX_WALL_TIME_MS = 600000;

/** Directories to ignore in file tree */
export const IGNORED_DIRECTORIES = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.svelte-kit',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.idea',
  '.vscode',
  '.DS_Store',
];

/** File extensions to ignore in file tree */
export const IGNORED_EXTENSIONS = [
  '.min.js',
  '.min.css',
  '.map',
  '.lock',
  '.log',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
];
