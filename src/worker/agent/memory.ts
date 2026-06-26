/**
 * Simple file-based memory for the coding agent.
 *
 * Stores session summaries under `.suncode/memories/` so the agent
 * can recall what was done in prior sessions.  Inspired by Codex's
 * `~/.codex/memories/` design.
 *
 * ## On-disk layout
 *
 *   .suncode/memories/
 *   ├── MEMORY.md              ← merged index, read on startup
 *   └── <date>-<slug>.md       ← per-session summaries
 *
 * ## Limits
 *   - Max 30 memory files (oldest pruned).
 *   - MEMORY.md is replaced on every save (not appended).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const MEMORIES_DIR = '.suncode/memories';
const MEMORY_INDEX = 'MEMORY.md';
const MAX_FILES = 30;

export interface MemoryEntry {
  /** ISO date string (YYYY-MM-DD). */
  date: string;
  /** Short slug for the file name (derived from the first user prompt). */
  slug: string;
  /** What the user asked. */
  userRequest: string;
  /** Summary of tools executed (count by name). */
  toolsUsed: Record<string, number>;
  /** Key outcomes — extracted from the assistant's final response. */
  summary: string;
}

/** Load the merged memory index (MEMORY.md) as a string for injection
 *  into the system prompt.  Returns '' if no memories exist. */
export function loadMemories(workingDir: string): string {
  const memDir = join(workingDir, MEMORIES_DIR);
  if (!existsSync(memDir)) return '';

  const indexPath = join(memDir, MEMORY_INDEX);
  if (!existsSync(indexPath)) return '';

  try {
    const content = readFileSync(indexPath, 'utf-8').trim();
    if (!content) return '';
    // Truncate to ~2000 chars to avoid bloating the system prompt
    return content.slice(0, 2000);
  } catch {
    return '';
  }
}

/** Persist a single session memory and regenerate MEMORY.md. */
export function saveMemory(workingDir: string, entry: MemoryEntry): void {
  const memDir = join(workingDir, MEMORIES_DIR);
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true });
  }

  // Write the per-session file
  const sessionPath = join(memDir, `${entry.date}-${entry.slug}.md`);
  const sessionContent = formatSessionMemory(entry);
  writeFileSync(sessionPath, sessionContent, 'utf-8');

  // Prune old files
  pruneOldMemories(memDir);

  // Rebuild the merged index
  const indexContent = buildMemoryIndex(memDir);
  writeFileSync(join(memDir, MEMORY_INDEX), indexContent, 'utf-8');
}

/** Format a single session memory as a markdown file. */
function formatSessionMemory(entry: MemoryEntry): string {
  const toolList = Object.entries(entry.toolsUsed)
    .map(([name, count]) => `  - ${name} ×${count}`)
    .join('\n');

  return [
    `---`,
    `date: ${entry.date}`,
    `---`,
    '',
    `## ${entry.userRequest.slice(0, 80)}`,
    '',
    `**工具使用**:`,
    toolList || '  (无)',
    '',
    `**摘要**:`,
    entry.summary || '(无)',
    '',
  ].join('\n');
}

/** Rebuild MEMORY.md by concatenating all session files (newest first). */
function buildMemoryIndex(memDir: string): string {
  const files = listMemoryFiles(memDir);
  if (files.length === 0) return '<!-- SunCode memory index — auto-generated -->\n';

  const parts: string[] = [
    '<!-- SunCode memory index — auto-generated -->',
    '',
    `> ${files.length} 个历史会话记录。以下是最新的 ${Math.min(files.length, 10)} 条：`,
    '',
  ];

  for (let i = 0; i < Math.min(files.length, 10); i++) {
    try {
      const content = readFileSync(join(memDir, files[i]!), 'utf-8');
      const lines = content.split('\n');
      // Skip YAML frontmatter
      let bodyStart = 0;
      if (lines[0]?.trim() === '---') {
        const end = lines.indexOf('---', 1);
        bodyStart = end === -1 ? 0 : end + 1;
      }
      parts.push(lines.slice(bodyStart).join('\n').trim());
    } catch {
      // Skip unreadable files
    }
  }

  return parts.join('\n') + '\n';
}

/** Delete oldest files when exceeding MAX_FILES. */
function pruneOldMemories(memDir: string): void {
  const files = listMemoryFiles(memDir);
  if (files.length <= MAX_FILES) return;

  for (const file of files.slice(MAX_FILES)) {
    try {
      unlinkSync(join(memDir, file!));
    } catch {
      /* skip */
    }
  }
}

/** List memory files (excl. MEMORY.md) sorted newest-first by filename. */
function listMemoryFiles(memDir: string): string[] {
  try {
    return readdirSync(memDir)
      .filter((f) => f.endsWith('.md') && f !== MEMORY_INDEX)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
