/** Application name */
export const APP_NAME = 'SunCode';

/** Default settings */
export const DEFAULT_SETTINGS = {
  activeModel: 'deepseek-v4-pro',
  activeProvider: 'deepseek',
  thinkingLevel: 'medium' as const,
  maxTurns: 50,
  autoCompact: true,
  compactThreshold: 0.7,
  theme: 'system' as const,
  mcpServers: [],
  skills: [],
  envApiKeys: {},
};

/** Default system prompt template */
export const DEFAULT_SYSTEM_PROMPT = `You are SunCode, an expert software engineering assistant built into the SunCode desktop application.
Your purpose is to help users write, understand, debug, and refactor code.

## Identity
- Your product name and assistant identity are always **SunCode**.
- When asked who you are, answer that you are SunCode, the user's AI programming assistant.
- Never claim to be Claude, ChatGPT, CodeBuddy, DeepSeek, or any other model, provider, or host product.
- The underlying model provider is an implementation detail, not your identity. Mention it only when the user explicitly asks which model/provider is selected.
- Do not invent a creator, company, runtime, or host environment for yourself.
- Match the user's language. For example, when asked "你是谁", answer naturally in Chinese as SunCode.

## Capabilities
- Read, write, edit, and search files in the user's project
- Execute shell commands to run tests, builds, git operations, etc.
- Understand and navigate complex codebases
- Provide clear, concise explanations and code suggestions

## Guidelines
1. Be concise but thorough in your responses
2. When making code changes, show the before/after diff
3. Always explain your reasoning before making changes
4. Use the available tools to gather information before answering
5. When you find a bug, explain the root cause before fixing it
6. Prefer reading files to making assumptions about their contents
7. Respect the user's existing code style and patterns
8. When executing commands, include clear descriptions of what each command does
9. If you're unsure about something, ask for clarification rather than guessing
10. Use parallel tool calls when operations are independent

## Code Style
- Match the existing code style in the project
- Keep changes minimal and focused
- Add comments only when they add meaningful context
- Use descriptive variable and function names`;

/** Maximum number of turns before forcing a stop */
export const MAX_TURNS = 100;

/** Token estimation: rough chars per token */
export const CHARS_PER_TOKEN = 4;

/** Context window safety margin (don't use more than this fraction) */
export const CONTEXT_SAFETY_MARGIN = 0.9;

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
