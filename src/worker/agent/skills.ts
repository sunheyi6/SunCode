import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { toSkillCommandName } from '@shared/commands';
import { getVendorSkillDirectories } from '@shared/skill-directories';

const preloadedSkillContents = new Map<string, Promise<string>>();

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
    name?: string;
    description?: string;
    trigger?: string[];
    priority?: number;
  };
}

export function preloadSkills(
  workingDir: string,
  additionalPaths: string[] = [],
  disabledSkillPaths: string[] = [],
): void {
  const cacheKey = getSkillsCacheKey(workingDir, additionalPaths, disabledSkillPaths);
  if (!preloadedSkillContents.has(cacheKey)) {
    preloadedSkillContents.set(
      cacheKey,
      loadAllSkills(workingDir, additionalPaths, disabledSkillPaths, getBuiltinSkillsDir()),
    );
  }
}

export function createSkillsLoader(
  workingDir: string,
  additionalPaths: string[] = [],
  disabledSkillPaths: string[] = [],
) {
  /**
   * Resolve the built-in skills directory shipped with SunCode.
   * In dev: __dirname is dist-electron/worker/, go up 2 levels to project root.
   * In production (packaged Electron): __dirname is app.asar/..., go up to resources/.
   */
  const builtinSkillsDir = getBuiltinSkillsDir();

  return {
    /**
     * Load all skills from configured paths.
     * Searches: built-in (shipped with SunCode), .suncode/skills/ (project),
     * ~/.suncode/skills/ (user), Codex user skills, and any additional configured paths.
     * Built-in skills load first so project/user skills can override them by name.
     */
    async loadAll(): Promise<string> {
      const cacheKey = getSkillsCacheKey(workingDir, additionalPaths, disabledSkillPaths);
      const preloaded = preloadedSkillContents.get(cacheKey);
      if (preloaded) {
        preloadedSkillContents.delete(cacheKey);
        return preloaded;
      }
      return loadAllSkills(workingDir, additionalPaths, disabledSkillPaths, builtinSkillsDir);
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

function getBuiltinSkillsDir(): string {
  // Check for Electron production path first.
  if (typeof process !== 'undefined' && process.resourcesPath) {
    return join(process.resourcesPath, 'skills');
  }
  // Development: resolve relative to worker directory.
  return join(__dirname, '..', '..', 'skills');
}

function getSkillsCacheKey(
  workingDir: string,
  additionalPaths: string[],
  disabledSkillPaths: string[],
): string {
  return JSON.stringify([workingDir, additionalPaths, disabledSkillPaths]);
}

async function loadAllSkills(
  workingDir: string,
  additionalPaths: string[],
  disabledSkillPaths: string[],
  builtinSkillsDir?: string,
): Promise<string> {
  const skills: Skill[] = [];
  const resolvedBuiltinSkillsDir = builtinSkillsDir || join(__dirname, '..', '..', 'skills');

  if (existsSync(resolvedBuiltinSkillsDir)) {
    skills.push(...(await loadSkillsFromDir(resolvedBuiltinSkillsDir, 'builtin')));
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || '~';
  for (const { path, source } of getVendorSkillDirectories(homeDir)) {
    if (existsSync(path)) skills.push(...(await loadSkillsFromDir(path, source)));
  }

  const projectSkillsDir = join(workingDir, '.suncode', 'skills');
  if (existsSync(projectSkillsDir))
    skills.push(...(await loadSkillsFromDir(projectSkillsDir, 'project')));

  const userSkillsDir = join(homeDir, '.suncode', 'skills');
  if (existsSync(userSkillsDir)) skills.push(...(await loadSkillsFromDir(userSkillsDir, 'user')));

  for (const path of additionalPaths) {
    if (existsSync(path)) skills.push(...(await loadSkillsFromDir(path, 'extra')));
  }

  const disabled = new Set(disabledSkillPaths);
  const deduped = new Map<string, Skill>();
  for (const skill of skills) {
    if (!disabled.has(skill.path)) deduped.set(skill.name, skill);
  }

  const sorted = [...deduped.values()].sort(
    (a, b) => (b.metadata?.priority || 0) - (a.metadata?.priority || 0),
  );
  return formatSkillsForPrompt(sorted);
}

async function loadSingleSkillFile(
  filePath: string,
  source: string,
  fallbackName: string,
): Promise<Skill | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const metadata = parseFrontmatter(content);
    const body = stripFrontmatter(content);
    return {
      name: metadata?.name || fallbackName,
      path: filePath,
      content: body,
      metadata: {
        ...metadata,
        description: metadata?.description || `Skill from ${source}`,
      },
    };
  } catch {
    return null;
  }
}

async function loadSkillsFromDir(dir: string, source: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        // Flat .md file in the skills dir
        const filePath = join(dir, entry.name);
        const skill = await loadSingleSkillFile(filePath, source, entry.name.replace('.md', ''));
        if (skill) skills.push(skill);
      } else if (entry.isDirectory()) {
        // Subdirectory — look for SKILL.md inside (agentskills.io convention)
        const skillFile = join(dir, entry.name, 'SKILL.md');
        try {
          const content = await readFile(skillFile, 'utf-8');
          const metadata = parseFrontmatter(content);
          const body = stripFrontmatter(content);
          const name = metadata?.name || entry.name;
          skills.push({
            name,
            path: skillFile,
            content: body,
            metadata: {
              ...metadata,
              description: metadata?.description || `Skill: ${name} (from ${source})`,
            },
          });
        } catch {
          // No SKILL.md in this subdirectory — skip
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
): { name?: string; description?: string; trigger?: string[]; priority?: number } | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;

  const yamlText = match[1];
  const result: { description?: string; trigger?: string[]; priority?: number } = {};

  try {
    // Very simple YAML parser for the fields we care about
    for (const line of yamlText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('description:')) {
        result.description = trimmed
          .slice('description:'.length)
          .trim()
          .replace(/^["']|["']$/g, '');
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

/** Generate a brief skill index for the system prompt.
 *  Only includes name + description + file path so the model knows
 *  which skills exist.  The full SKILL.md content is NOT injected —
 *  the model must use the read tool to load it on demand.
 *  Follows the agentskills.io / pi convention. */
function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const lines: string[] = [
    'The following skills are available. When a task matches a skill description,',
    'use the **read** tool to load the skill file at the listed path BEFORE starting work.',
    'If the user invokes a listed /skill-command, load that exact skill before replying.',
    'Do not guess the skill content — always read it first.',
    '',
  ];

  for (const skill of skills) {
    lines.push(
      `- **${skill.name}** (command: \`/${toSkillCommandName(skill.name)}\`): ${skill.metadata?.description || 'No description'}`,
    );
    lines.push(`  Path: \`${skill.path}\``);
  }

  lines.push('');
  lines.push('Read the full skill file when the task matches its description.');

  return lines.join('\n');
}
