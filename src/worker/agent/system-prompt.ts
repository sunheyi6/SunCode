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

  // Base system prompt
  parts.push(customPrompt || DEFAULT_SYSTEM_PROMPT);

  // Permission mode — tells the model how to behave regarding tool execution.
  parts.push('');
  parts.push('## Permission Mode');
  parts.push(permissionInstructions(permissionMode));

  // Environment info
  const shellInfo = getShellInfo();
  parts.push('');
  parts.push('## Environment');
  parts.push(`- Working directory: ${workingDir}`);
  parts.push(`- Operating system: ${shellInfo.osName}`);
  parts.push(`- Shell: ${shellInfo.shell}`);
  parts.push(`- Shell type: ${shellInfo.shellType}`);
  parts.push(`- Date: ${new Date().toISOString().split('T')[0]}`);
  parts.push(`- Maximum turns: ${maxTurns}`);
  parts.push('');
  parts.push(shellInfo.guidance);

  // Auto-generated memories from prior sessions (Codex-style).
  if (memoryContent) {
    parts.push('');
    parts.push('<project_memory>');
    parts.push('The following is a summary of past work in this project. Use it to');
    parts.push('understand the project context and avoid re-exploring known ground.');
    parts.push('');
    parts.push(memoryContent);
    parts.push('</project_memory>');
  }

  // Workspace instructions from .agents.md (Codex convention).
  // Structured as project_context following the pi/Codex convention so the
  // model can clearly separate project rules from general instructions.
  if (agentsMdContent) {
    parts.push('');
    parts.push('<project_context>');
    parts.push(agentsMdContent);
    parts.push('</project_context>');
  }

  // Tools section — one-line summaries save significant tokens vs full JSON Schema.
  parts.push('');
  parts.push('## Available Tools');
  parts.push('');
  for (const tool of tools) {
    parts.push(`- **${tool.name}**: ${getToolSnippet(tool)}`);
  }

  // Tool usage guidelines
  parts.push('## Tool Usage Guidelines');
  parts.push(
    '1. You may call multiple tools in a single response when operations are independent.',
  );
  parts.push('2. Always read files before editing them - never assume file contents.');
  parts.push('3. When making edits, use the edit tool with exact string matching.');
  parts.push(
    '4. When executing bash commands, include clear descriptions of what each command does.',
  );
  parts.push('5. Search for code patterns with grep before making broad changes.');
  parts.push('6. If a tool returns an error, analyze the error and adjust your approach.');
  parts.push(
    '7. After completing all necessary changes, call task_complete with a summary of what was done.',
  );
  parts.push('8. Only call task_complete as the final action — never together with other tools.');

  // Skills section — wrapped in available_skills XML per agentskills.io convention
  if (skillsContent) {
    parts.push('');
    parts.push('<available_skills>');
    parts.push(skillsContent);
    parts.push('</available_skills>');
  }

  // Final instruction
  parts.push('');
  parts.push('## CRITICAL: Git Push Rule');
  parts.push(
    'If the user asked to push/提交到远端/上传: ALL git operations MUST be chained in ONE bash call ending with git push. Example:',
  );
  parts.push('  git add <files> && git commit -m "msg" && git push');
  parts.push(
    'Never stop after commit. Never output text between commit and push. Commit without push = FAILURE.',
  );
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
