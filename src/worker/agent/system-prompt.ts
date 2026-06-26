import { DEFAULT_SYSTEM_PROMPT } from '@shared/constants';
import type { AppSettings, ToolDefinition } from '@shared/types';

export interface SystemPromptInput {
  workingDir: string;
  tools: ToolDefinition[];
  skillsContent: string;
  maxTurns: number;
  /** Permission mode controls how the model should approach tool execution. */
  permissionMode: AppSettings['permissionMode'];
  /** Optional: Custom system prompt to override the default */
  customPrompt?: string;
  /** Optional: Content from .agents.md (Codex-style workspace instructions) */
  agentsMdContent?: string;
  /** Optional: Auto-generated memories from prior sessions */
  memoryContent?: string;
}

/**
 * Builds the system prompt for the agent.
 * Combines the base system prompt, tool descriptions, skills, and environment info.
 */
/**
 * Builds the system prompt for the agent.
 *
 * DESIGN NOTE (prompt caching): The system prompt is ordered for maximum cache
 * stability. Static content (base prompt, guidelines, rules) comes FIRST so it
 * always occupies the cacheable prefix. Semi-static content (tools, skills,
 * memory) comes LATER so changes to those sections only invalidate the tail of
 * the cache. Dynamic per-request data (date, etc.) is NOT included here — it
 * belongs in the user message after the cache breakpoint.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const {
    workingDir,
    tools,
    skillsContent,
    maxTurns,
    permissionMode,
    customPrompt,
    agentsMdContent,
    memoryContent,
  } = input;

  const parts: string[] = [];

  // ═══════════════════════════════════════════════════════
  // SECTION 1: STATIC CACHEABLE PREFIX
  // These sections rarely or never change — they form the
  // cacheable prefix that pi-ai marks with cache_control.
  // ═══════════════════════════════════════════════════════

  // 1a. Base system prompt (from constants — never changes at runtime)
  parts.push(customPrompt || DEFAULT_SYSTEM_PROMPT);

  // 1b. Git push rule (never changes)
  parts.push('');
  parts.push('## CRITICAL: Git Push Rule');
  parts.push(
    'If the user asked to push/提交到远端/上传: ALL git operations MUST be chained in ONE bash call ending with git push. Example:',
  );
  parts.push('  git add <files> && git commit -m "msg" && git push');
  parts.push(
    'Never stop after commit. Never output text between commit and push. Commit without push = FAILURE.',
  );

  // ═══════════════════════════════════════════════════════
  // SECTION 2: SEMI-STATIC CONTENT
  // These change infrequently (per-session or per-settings-change).
  // They come AFTER the cacheable prefix so prefix cache hits
  // survive changes to these sections.
  // ═══════════════════════════════════════════════════════

  // 2a. Permission mode — changes when user toggles settings
  parts.push('');
  parts.push('## Permission Mode');
  parts.push(permissionInstructions(permissionMode));

  // 2b. Environment info — working dir and shell are per-session, OS is constant
  // NOTE: Date is intentionally OMITTED. Injecting a daily-changing string
  // into the system prompt would invalidate the prompt cache every midnight.
  const shellInfo = getShellInfo();
  parts.push('');
  parts.push('## Environment');
  parts.push(`- Working directory: ${workingDir}`);
  parts.push(`- Operating system: ${shellInfo.osName}`);
  parts.push(`- Shell: ${shellInfo.shell}`);
  parts.push(`- Shell type: ${shellInfo.shellType}`);
  parts.push(`- Maximum turns: ${maxTurns}`);
  parts.push('');
  parts.push(shellInfo.guidance);

  // 2c. Available Tools — changes when tool registry changes (rare)
  parts.push('');
  parts.push('## Available Tools');
  parts.push('');
  for (const tool of tools) {
    parts.push(`- **${tool.name}**: ${getToolSnippet(tool)}`);
  }

  // ═══════════════════════════════════════════════════════
  // SECTION 3: PROJECT-SPECIFIC DYNAMIC CONTENT
  // These change with project state (memory, skills, agents.md).
  // They're at the END so the static/semi-static prefix above
  // stays cacheable even when project content updates.
  // ═══════════════════════════════════════════════════════

  // 3a. Project memory (auto-generated, changes between sessions)
  if (memoryContent) {
    parts.push('');
    parts.push('<project_memory>');
    parts.push('The following is a summary of past work in this project. Use it to');
    parts.push('understand the project context and avoid re-exploring known ground.');
    parts.push('');
    parts.push(memoryContent);
    parts.push('</project_memory>');
  }

  // 3b. Workspace instructions from .agents.md
  if (agentsMdContent) {
    parts.push('');
    parts.push('<project_context>');
    parts.push(agentsMdContent);
    parts.push('</project_context>');
  }

  // 3c. Skills — changes when skill files are added/modified
  if (skillsContent) {
    parts.push('');
    parts.push('<available_skills>');
    parts.push(skillsContent);
    parts.push('</available_skills>');
  }

  // Final instruction (stable, kept at end for readability)
  parts.push('');
  parts.push(
    "Begin by analyzing the user's request carefully. Use tools to gather information before proposing or making changes.",
  );

  return parts.join('\n');
}

function permissionInstructions(mode: AppSettings['permissionMode']): string {
  switch (mode) {
    case 'full_access':
      return '**完全访问** — 你拥有对工作区的完全访问权限。直接执行工具，不需要询问用户确认。大胆行动，承担风险，事后报告结果。';
    case 'auto_edit':
      return '**自动编辑** — 你可以自由读写文件。执行 bash 命令前需简要说明目的（一句话即可，不需要等待确认）。';
    case 'confirm_changes':
      return '**变更前确认** — 在对文件做任何修改之前，先向用户说明你打算做什么并等待确认，然后再执行。读取操作不需要确认。';
    case 'plan':
      return '**计划模式** — 你只能使用 read/grep/glob 等只读工具。不要执行 write/edit/bash 等会修改文件的工具。分析用户请求并给出详细的执行计划。';
  }
}

/** Shell environment info based on the current platform. */
function getShellInfo(): { osName: string; shell: string; shellType: string; guidance: string } {
  const platform = process.platform;
  let osName: string;
  let shell: string;
  let shellType: string;
  let guidance: string;

  if (platform === 'win32') {
    osName = 'Windows';
    shell = 'pwsh.exe';
    shellType = 'PowerShell';
    guidance =
      'The bash tool runs PowerShell (pwsh.exe) on this Windows system. ' +
      'Key notes for PowerShell:\n' +
      '  - Use `&&` to chain commands (same as bash).\n' +
      '  - Double quotes for strings with spaces, single quotes for literals.\n' +
      '  - Standard Unix aliases (ls, cat, rm, cp, mv, mkdir, grep) are available.\n' +
      '  - Environment variables: use `$env:VAR` instead of `$VAR`.\n' +
      '  - Avoid cmd.exe-specific syntax (e.g., `type` for cat, `copy` for cp).\n' +
      '  - Git commands work identically to Unix.';
  } else if (platform === 'darwin') {
    osName = 'macOS';
    shell = '/bin/bash';
    shellType = 'Bash';
    guidance =
      'The bash tool runs bash on this macOS system. ' +
      'Standard Unix/Linux commands and shell syntax apply.';
  } else {
    osName = 'Linux';
    shell = '/bin/bash';
    shellType = 'Bash';
    guidance =
      'The bash tool runs bash on this Linux system. ' +
      'Standard Unix/Linux commands and shell syntax apply.';
  }

  return { osName, shell, shellType, guidance };
}

/** One-line summaries for built-in tools.  Concise but complete enough that
 *  the model knows which tool to pick and which parameters are required.
 *  Full JSON Schema is still available via `tool.getDefinition()` for
 *  function-calling providers that need it. */
function getToolSnippet(tool: ToolDefinition): string {
  const snippets: Record<string, string> = {
    read: 'Read file contents with line numbers. `file_path` (required), `offset`, `limit`. Also reads images as base64.',
    write: 'Create or overwrite a file (creates parent dirs). `file_path` and `content` required.',
    edit: 'Exact string replacement in a file. `file_path`, `old_string`, `new_string` required. `replace_all` (bool) replaces all occurrences. Fails if old_string is not unique.',
    bash: 'Execute a shell command. `command` (required). For git push: chain add+commit+push with && in one call.',
    grep: 'Regex search via ripgrep. `pattern` (required), `path`, `glob` filter, `type` filter, `multiline` (bool), `ignoreCase` (bool). Supports -A/-B/-C context.',
    glob: 'Find files by glob pattern. `pattern` required (e.g. "**/*.ts"). `path` (search dir). Results sorted by mtime.',
    task_complete:
      'Signal task completion. `summary` (required) — describe what was accomplished. Use this as the final action instead of just outputting text.',
  };
  return snippets[tool.name] ?? tool.description.slice(0, 120);
}
