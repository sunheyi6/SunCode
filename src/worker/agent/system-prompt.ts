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

  // Workspace instructions from .agents.md (Codex convention)
  if (agentsMdContent) {
    parts.push('');
    parts.push('## Workspace Instructions');
    parts.push('The following user-provided instructions apply to this project:');
    parts.push('');
    parts.push(agentsMdContent);
  }

  // Tools section
  parts.push('');
  parts.push('## Available Tools');
  parts.push(
    'You have access to the following tools. Use them to explore, modify, and execute code.',
  );
  parts.push('');

  for (const tool of tools) {
    parts.push(`### ${tool.name}`);
    parts.push(tool.description);
    parts.push('');
    parts.push('Parameters:');
    parts.push('```json');
    parts.push(JSON.stringify(tool.parameters, null, 2));
    parts.push('```');
    parts.push('');
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

  // Skills section
  if (skillsContent) {
    parts.push('');
    parts.push('## Skills');
    parts.push('The following domain-specific skills and instructions apply to this project:');
    parts.push('');
    parts.push(skillsContent);
  }

  // Final instruction
  parts.push('');
  parts.push(
    "Begin by analyzing the user's request carefully. Use tools to gather information before proposing or making changes.",
  );

  return parts.join('\n');
}
