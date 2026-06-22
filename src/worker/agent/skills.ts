import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Skills system: loads .md skill files from project and user directories.
 * Skills are injected into the system prompt to provide domain-specific
 * instructions and conventions.
 */
export interface Skill {
  name: string;
  path: string;
  content: string;
  /** Optional YAML frontmatter metadata */
  metadata?: {
    description?: string;
    trigger?: string[];
    priority?: number;
  };
}

export function createSkillsLoader(
  workingDir: string,
  additionalPaths: string[] = [],
) {
  return {
    /**
     * Load all skills from configured paths.
     * Searches: .suncode/skills/ (project), ~/.suncode/skills/ (user),
     * and any additional configured paths.
     */
    async loadAll(): Promise<string> {
      const skills: Skill[] = [];

      // Project-level skills
      const projectSkillsDir = join(workingDir, '.suncode', 'skills');
      if (existsSync(projectSkillsDir)) {
        const projectSkills = await loadSkillsFromDir(projectSkillsDir, 'project');
        skills.push(...projectSkills);
      }

      // User-level skills
      const homeDir = process.env.HOME || process.env.USERPROFILE || '~';
      const userSkillsDir = join(homeDir, '.suncode', 'skills');
      if (existsSync(userSkillsDir)) {
        const userSkills = await loadSkillsFromDir(userSkillsDir, 'user');
        skills.push(...userSkills);
      }

      // Additional configured paths
      for (const path of additionalPaths) {
        if (existsSync(path)) {
          const extraSkills = await loadSkillsFromDir(path, 'extra');
          skills.push(...extraSkills);
        }
      }

      // Sort by priority (higher first)
      skills.sort((a, b) => (b.metadata?.priority || 0) - (a.metadata?.priority || 0));

      // Format skills into system prompt content
      return formatSkillsForPrompt(skills);
    },

    /**
     * Load a single skill file.
     */
    async loadSkill(filePath: string): Promise<Skill | null> {
      try {
        const content = await readFile(filePath, 'utf-8');
        const name = filePath.split(/[/\\]/).pop()?.replace('.md', '') || 'unknown';

        // Simple YAML frontmatter parser (--- ... ---)
        const metadata = parseFrontmatter(content);
        const body = stripFrontmatter(content);

        return {
          name,
          path: filePath,
          content: body,
          metadata,
        };
      } catch {
        return null;
      }
    },
  };
}

async function loadSkillsFromDir(dir: string, source: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        const filePath = join(dir, entry.name);
        try {
          const content = await readFile(filePath, 'utf-8');
          const metadata = parseFrontmatter(content);
          const body = stripFrontmatter(content);

          skills.push({
            name: entry.name.replace('.md', ''),
            path: filePath,
            content: body,
            metadata: {
              ...metadata,
              // Tag the source
              description: metadata.description || `Skill from ${source}`,
            },
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch {
    // Directory might not exist
  }

  return skills;
}

/**
 * Parse YAML frontmatter from markdown.
 * Frontmatter is delimited by --- at the start.
 */
function parseFrontmatter(
  content: string,
): { description?: string; trigger?: string[]; priority?: number } | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;

  const yamlText = match[1];
  const result: { description?: string; trigger?: string[]; priority?: number } = {};

  try {
    // Very simple YAML parser for the fields we care about
    for (const line of yamlText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('description:')) {
        result.description = trimmed.slice('description:'.length).trim().replace(/^["']|["']$/g, '');
      } else if (trimmed.startsWith('priority:')) {
        result.priority = Number.parseInt(trimmed.slice('priority:'.length).trim(), 10);
      } else if (trimmed.startsWith('trigger:')) {
        // Could be a list, but for now just capture the value
        const val = trimmed.slice('trigger:'.length).trim();
        result.trigger = val ? [val] : [];
      }
    }
  } catch {
    // Ignore parse errors
  }

  return result;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const parts: string[] = [];

  for (const skill of skills) {
    parts.push(`### ${skill.name}`);
    if (skill.metadata?.description) {
      parts.push(`*${skill.metadata.description}*`);
    }
    parts.push('');
    parts.push(skill.content);
    parts.push('');
  }

  return parts.join('\n');
}
