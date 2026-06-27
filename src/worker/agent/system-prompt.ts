import { DEFAULT_SYSTEM_PROMPT } from '@shared/constants';
import type { AppSettings, ToolDefinition } from '@shared/types';

export interface SystemPromptInput {
  workingDir: string;
  tools: ToolDefinition[];
  skillsContent: string;
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
 * Follows pi-agent-core's minimal approach: base prompt + tools + date/cwd.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const {
    workingDir,
    tools,
    skillsContent,
    permissionMode,
    customPrompt,
    agentsMdContent,
    memoryContent,
  } = input;

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const promptCwd = workingDir.replace(/\\/g, '/');

  const parts: string[] = [];

  // Base system prompt
  parts.push(customPrompt || DEFAULT_SYSTEM_PROMPT);

  // Permission mode (one line, always append to base)
  parts.push('');
  parts.push(permissionMode === 'plan' ? '## Mode: plan — read-only tools only' : '');

  // Tool-specific usage guidelines (like pi's promptGuidelines)
  const toolGuidelines = getToolGuidelines(tools.map((t) => t.name));
  if (toolGuidelines.length > 0) {
    parts.push('');
    parts.push('## Guidelines');
    for (const g of toolGuidelines) {
      parts.push(`- ${g}`);
    }
  }

  // Available Tools (same as pi's approach)
  if (tools.length > 0) {
    parts.push('');
    parts.push('## Available Tools');
    for (const tool of tools) {
      parts.push(`- **${tool.name}**: ${getToolSnippet(tool)}`);
    }
  }

  // Project memory
  if (memoryContent) {
    parts.push('');
    parts.push('<project_memory>');
    parts.push(memoryContent);
    parts.push('</project_memory>');
  }

  // Workspace instructions
  if (agentsMdContent) {
    parts.push('');
    parts.push('<project_context>');
    parts.push(agentsMdContent);
    parts.push('</project_context>');
  }

  // Skills
  if (skillsContent) {
    parts.push('');
    parts.push('<available_skills>');
    parts.push(skillsContent);
    parts.push('</available_skills>');
  }

  // Date and working directory (like pi)
  parts.push(`\nCurrent date: ${date}`);
  parts.push(`Current working directory: ${promptCwd}`);

  return parts.join('\n').replace(/\n{3,}/g, '\n\n'); // Collapse excessive blank lines
}

/**
 * Tool-specific usage guidelines, matching pi-agent-core's promptGuidelines.
 * These are added to the system prompt to tell the model WHEN to use each tool.
 */
function getToolGuidelines(toolNames: string[]): string[] {
  const all: Record<string, string[]> = {
    read: ['Use read to examine files instead of cat or sed.'],
    bash: [
      'For file operations like ls, find, grep: use the dedicated tools (ls, find, grep) instead of bash.',
    ],
    edit: ['Read a file before editing it. Make precise edits.'],
    task_complete: [],
  };
  const result: string[] = [];
  for (const name of toolNames) {
    const guidelines = all[name];
    if (guidelines) {
      for (const g of guidelines) {
        if (!result.includes(g)) result.push(g);
      }
    }
  }
  result.push('Be concise in your responses');
  result.push('Show file paths clearly when working with files');
  return result;
}

function getToolSnippet(tool: ToolDefinition): string {
  // Short one-liners matching pi-agent-core's promptSnippet style.
  // Detailed parameter schema is sent via the LLM tools array.
  const snippets: Record<string, string> = {
    read: 'Read file contents',
    write: 'Create or overwrite a file',
    edit: 'Make precise file edits',
    bash: 'Execute a shell command',
    grep: 'Search file contents with patterns',
    glob: 'Find files by glob pattern',
    ls: 'List directory contents',
    find: 'Find files by name pattern',
  };
  return snippets[tool.name] ?? tool.description.slice(0, 60);
}
