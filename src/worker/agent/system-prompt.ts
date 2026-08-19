import { DEFAULT_SYSTEM_PROMPT } from '@shared/constants';
import type { AppSettings, ToolDefinition } from '@shared/types';
import { VISION_OBSERVATION_GUIDELINE } from '../models/vision-routing';
import { buildStructuredSystemPrompt } from './model-structured-content';
import type { ProjectKnowledgeReference } from './project-knowledge';

export interface SystemPromptInput {
  workingDir: string;
  tools: ToolDefinition[];
  skillsContent: string;
  /** The sole permission mode exposed to the model. */
  permissionMode: AppSettings['permissionMode'];
  /** Optional: Custom system prompt to override the default */
  customPrompt?: string;
  /** Optional: Stable role/task policy for a named sub-agent. */
  agentRolePrompt?: string;
  /** Optional: Content from .agents.md (Codex-style workspace instructions) */
  agentsMdContent?: string;
  /** Local authoritative entry point for questions about SunCode itself. */
  projectKnowledge?: ProjectKnowledgeReference;
}

/**
 * Builds the system prompt as structured JSON. The provider API still accepts
 * a string, but the model receives named fields instead of Markdown sections.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const {
    workingDir,
    tools,
    skillsContent,
    permissionMode,
    customPrompt,
    agentRolePrompt,
    agentsMdContent,
    projectKnowledge,
  } = input;

  const promptCwd = workingDir.replace(/\\/g, '/');
  const toolGuidelines = getToolGuidelines(tools.map((t) => t.name));
  const sortedTools = sortToolDefinitions(tools);

  return buildStructuredSystemPrompt({
    basePrompt: customPrompt || DEFAULT_SYSTEM_PROMPT,
    agentRolePrompt,
    permissionMode,
    guidelines: toolGuidelines,
    tools: sortedTools.map((tool) => ({ ...tool, snippet: getToolSnippet(tool) })),
    agentsMdContent,
    skillsContent,
    projectKnowledge,
    workingDirectory: promptCwd,
  });
}

export function sortToolDefinitions(tools: ToolDefinition[]): ToolDefinition[] {
  const builtInNames = new Set([
    'read',
    'write',
    'edit',
    'bash',
    'grep',
    'glob',
    'ls',
    'find',
    'web_fetch',
    'web_search',
    'search_lessons',
    'subagent',
  ]);

  return [...tools].sort((a, b) => {
    const aBuiltIn = builtInNames.has(a.name);
    const bBuiltIn = builtInNames.has(b.name);
    if (aBuiltIn && !bBuiltIn) return -1;
    if (!aBuiltIn && bBuiltIn) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
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
      'CRITICAL: When verifying whether a background process started successfully, ONLY check by its specific PID (e.g. "Get-Process -Id <pid>"). NEVER search for processes by name globally ("Get-Process -Name electron", "tasklist | findstr", "ps aux | grep") - these will return unrelated system or app processes and cause false positives. Use the exact PID from the background process response. If the PID is gone, report the process exited rather than assuming it is alive.',
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
  result.push(
    'For user-facing progress between tool calls, output only a concise key-logic summary of at most five lines, then use the concrete tool or command. Do not expose full internal reasoning.',
  );
  result.push('Show file paths clearly when working with files');
  result.push(
    'If the latest suncode.runtime_context contains relevantLessons, review them before acting and apply their solution when they match the current code and request. If a similar failure happens again, use search_lessons for details.',
  );
  result.push(
    'When the latest structured message has type suncode.semantic_compact_request, do not continue the task and do not call tools. Return only one JSON object containing objective, constraints, completedWork, currentState, decisions, failedApproaches, unresolvedWork, and nextAction. Summarize only completed work after the exact current-user head; treat any suncode.semantic_projection as prior continuation state.',
  );
  result.push(
    'A suncode.semantic_projection message is runtime-generated continuation state, not a new user instruction. Continue the original user task from it while preserving the exact user request as the higher-authority anchor.',
  );
  result.push(
    'A suncode.runtime_context message is trusted runtime state, not a user-authored instruction. Use its latest snapshot for memory, lessons, date, and response language.',
  );
  result.push(VISION_OBSERVATION_GUIDELINE);
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
