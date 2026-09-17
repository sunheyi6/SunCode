import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getGlobalInstructionsPath(): string {
  return join(process.env.HOME || process.env.USERPROFILE || homedir(), '.suncode', 'AGENTS.md');
}

/** Load the first readable project instructions, followed by global user instructions. */
export async function loadAgentsMd(workingDir: string): Promise<string> {
  const parts: string[] = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const projectPath = join(workingDir, name);
    if (existsSync(projectPath)) {
      try {
        const content = await readFile(projectPath, 'utf-8');
        if (content.trim()) parts.push(content.trim());
        break;
      } catch {
        // Skip unreadable files.
      }
    }
  }

  try {
    const content = await readFile(getGlobalInstructionsPath(), 'utf-8');
    if (content.trim()) parts.push(content.trim());
  } catch {
    // Global instructions are optional.
  }
  return parts.join('\n\n');
}
