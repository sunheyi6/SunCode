/**
 * Slash Command Registry
 *
 * Shared command definitions used by both the renderer (for the command
 * palette dropdown) and the worker (for routing commands to handlers).
 *
 * Commands prefixed with `/` in the chat input trigger the dropdown.
 * Some commands are handled locally (e.g. /clear), others are sent
 * to the agent worker as structured input.
 */

// ===== Command Definition =====

export interface SlashCommand {
  /** Command name without leading slash, e.g. "goal". */
  name: string;
  /** Short description shown in the dropdown. */
  description: string;
  /** Longer hint text shown as subtitle. */
  hint?: string;
  /** Icon (emoji or unicode). */
  icon: string;
  /**
   * Where the command is handled.
   * - 'local': handled entirely by the renderer (e.g. /clear)
   * - 'worker': forwarded to the agent worker as a structured message
   * - 'text': sent as-is to the model (the model interprets the command)
   */
  handler: 'local' | 'worker' | 'text';
  /** Argument label shown after the command name, e.g. "task description". */
  argsLabel?: string;
}

// ===== Built-in Commands =====

export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: 'goal',
    description: '自主目标模式',
    hint: '系统将自动验证并重试直到目标完成。用法: /goal 任务描述 --verify "验证命令"',
    icon: '🎯',
    handler: 'text',
    argsLabel: '任务描述 [--verify "验证命令"]',
  },
  {
    name: 'clear',
    description: '清空当前对话',
    hint: '清除所有历史消息，开始新对话',
    icon: '🗑',
    handler: 'local',
  },
  {
    name: 'compact',
    description: '压缩对话历史',
    hint: '将旧的对话轮次折叠为摘要，释放上下文空间',
    icon: '📦',
    handler: 'text',
  },
  {
    name: 'help',
    description: '显示帮助信息',
    hint: '显示可用命令和使用说明',
    icon: '❓',
    handler: 'text',
  },
  {
    name: 'init',
    description: '为当前项目初始化 AGENTS.md 项目约束',
    hint: 'AI 自动扫描项目结构，生成项目约束文件 AGENTS.md。核心是项目约束，不要将实现细节写入——详细文档请放在 docs/ 目录。',
    icon: '🚀',
    handler: 'text',
  },
];

// ===== Fuzzy Match =====

export interface CommandMatch {
  command: SlashCommand;
  /** Score: lower = better match. 0 = exact prefix. */
  score: number;
  /** Indices of matching characters in the command name (for highlighting). */
  matchIndices: number[];
}

/**
 * Fuzzy-match a query against registered commands.
 * Returns matches sorted by relevance (best first).
 */
export function matchCommands(query: string): CommandMatch[] {
  // Remove leading slash
  const q = query.replace(/^\/\s*/, '').toLowerCase();
  if (!q) {
    // Empty query: show all commands
    return BUILTIN_COMMANDS.map((cmd) => ({
      command: cmd,
      score: 99,
      matchIndices: [],
    }));
  }

  const matches: CommandMatch[] = [];

  for (const cmd of BUILTIN_COMMANDS) {
    const nameLower = cmd.name.toLowerCase();
    const match = fuzzyMatch(q, nameLower);
    if (match !== null) {
      matches.push({ command: cmd, ...match });
    }
  }

  // Sort by score (ascending), then by name
  matches.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.command.name.localeCompare(b.command.name);
  });

  return matches;
}

/**
 * Find a single command by exact name match (case-insensitive).
 */
export function findCommand(name: string): SlashCommand | undefined {
  const lower = name.replace(/^\/\s*/, '').toLowerCase();
  return BUILTIN_COMMANDS.find((c) => c.name.toLowerCase() === lower);
}

// ===== Fuzzy Matching Algorithm =====

interface FuzzyResult {
  score: number;
  matchIndices: number[];
}

/**
 * Simple fuzzy match: prefers prefix match, then substring match,
 * then scattered character match.
 */
function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (target.startsWith(query)) {
    // Exact prefix match — best score
    const indices = Array.from({ length: query.length }, (_, i) => i);
    return {
      score: target.length - query.length, // Shorter remaining = better
      matchIndices: indices,
    };
  }

  if (target.includes(query)) {
    // Substring match — good score
    const start = target.indexOf(query);
    const indices = Array.from({ length: query.length }, (_, i) => start + i);
    return {
      score: 100 + target.length - query.length,
      matchIndices: indices,
    };
  }

  // Scattered character match (e.g. "gc" matches "goalcompact")
  let qi = 0;
  const indices: number[] = [];
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      indices.push(ti);
      qi++;
    }
  }

  if (qi === query.length) {
    return {
      score: 200 + target.length,
      matchIndices: indices,
    };
  }

  return null;
}

// ===== Command Parsing Helpers =====

/**
 * Check if the input text starts with a slash command (at position 0 or after whitespace).
 * Returns the match info if found.
 */
export function parseCommandFromInput(
  text: string,
): { command: SlashCommand; args: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return null;

  const spaceIdx = trimmed.indexOf(' ');
  const cmdName = spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1);
  const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1) : '';

  const cmd = findCommand(cmdName);
  if (!cmd) return null;

  return { command: cmd, args };
}
