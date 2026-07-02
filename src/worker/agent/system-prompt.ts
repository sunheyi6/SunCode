import { DEFAULT_SYSTEM_PROMPT } from '@shared/constants';
import type { AppSettings, ToolDefinition } from '@shared/types';
import { buildStructuredSystemPrompt } from './model-structured-content';

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
  /** Optional: Retrieved failure lessons relevant to the current request */
  relevantLessonsContent?: string;
  /** Optional: Plan mode instructions (only when plan mode is active) */
  planModeInstructions?: string;
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
    agentsMdContent,
    memoryContent,
    relevantLessonsContent,
    planModeInstructions,
  } = input;

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const promptCwd = workingDir.replace(/\\/g, '/');
  const toolGuidelines = getToolGuidelines(tools.map((t) => t.name));
  const sortedTools = sortToolsForPrompt(tools);

  return buildStructuredSystemPrompt({
    basePrompt: customPrompt || DEFAULT_SYSTEM_PROMPT,
    permissionMode,
    planModeNotice: permissionMode === 'plan' ? 'read-only tools only' : undefined,
    guidelines: toolGuidelines,
    tools: sortedTools.map((tool) => ({ ...tool, snippet: getToolSnippet(tool) })),
    memoryContent,
    agentsMdContent,
    planModeInstructions,
    skillsContent,
    relevantLessonsContent,
    currentDate: date,
    workingDirectory: promptCwd,
  });
}

function sortToolsForPrompt(tools: ToolDefinition[]): ToolDefinition[] {
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
    'EnterPlanMode',
    'ExitPlanMode',
  ]);

  return [...tools].sort((a, b) => {
    const aBuiltIn = builtInNames.has(a.name);
    const bBuiltIn = builtInNames.has(b.name);
    if (aBuiltIn && !bBuiltIn) return -1;
    if (!aBuiltIn && bBuiltIn) return 1;
    return a.name.localeCompare(b.name);
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
  result.push('Show file paths clearly when working with files');
  result.push(
    'If context.relevantLessons is present, review it before acting and apply its solution when it matches the current code and request. If a similar failure happens again, use search_lessons for details.',
  );
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
