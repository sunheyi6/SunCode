import { DEFAULT_SYSTEM_PROMPT } from '@shared/constants';
import type { ToolDefinition } from '@shared/types';

export interface SystemPromptInput {
  workingDir: string;
  tools: ToolDefinition[];
  skillsContent: string;
  maxTurns: number;
  /** Optional: Custom system prompt to override the default */
  customPrompt?: string;
  /** Optional: Content from .agents.md (Codex-style workspace instructions) */
  agentsMdContent?: string;
}

/**
 * Builds the system prompt for the agent.
 * Combines the base system prompt, tool descriptions, skills, and environment info.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const { workingDir, tools, skillsContent, maxTurns, customPrompt, agentsMdContent } = input;

  const parts: string[] = [];

  // Base system prompt
  parts.push(customPrompt || DEFAULT_SYSTEM_PROMPT);

  // Environment info
  parts.push('');
  parts.push('## Environment');
  parts.push(`- Working directory: ${workingDir}`);
  parts.push(`- Operating system: ${process.platform}`);
  parts.push(`- Date: ${new Date().toISOString().split('T')[0]}`);
  parts.push(`- Maximum turns: ${maxTurns}`);

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
  parts.push('7. After completing all necessary changes, respond with a summary of what was done.');

  // Skills section — wrapped in available_skills XML per agentskills.io convention
  if (skillsContent) {
    parts.push('');
    parts.push('<available_skills>');
    parts.push(skillsContent);
    parts.push('</available_skills>');
  }

  // Final instruction
  parts.push('');
  parts.push(
    "Begin by analyzing the user's request carefully. Use tools to gather information before proposing or making changes.",
  );

  return parts.join('\n');
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
    bash: 'Execute a shell command. `command` (required), `description` (short summary), `timeout` ms (max 300000), `run_in_background` (bool).',
    grep: 'Regex search via ripgrep. `pattern` (required), `path`, `glob` filter, `type` filter, `multiline` (bool), `ignoreCase` (bool). Supports -A/-B/-C context.',
    glob: 'Find files by glob pattern. `pattern` required (e.g. "**/*.ts"). `path` (search dir). Results sorted by mtime.',
  };
  return snippets[tool.name] ?? tool.description.slice(0, 120);
}
