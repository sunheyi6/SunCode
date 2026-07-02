import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { BaseTool, obj, p } from './types';

export function createGlobTool(workingDir: string) {
  return new (class GlobTool extends BaseTool {
    readonly name = 'glob';
    isReadonly = true;
    readonly description =
      'Finds files matching a glob pattern. Supports standard glob patterns like **/*.ts, src/**/*.vue, etc. Results are sorted by modification time (newest first). Use this to discover files in the project.';
    readonly parameters = obj(
      {
        pattern: p(
          'string',
          'The glob pattern to match files against (e.g. "**/*.ts", "src/**/*.vue")',
        ),
        path: p('string', 'The directory to search in (default: working directory)'),
      },
      ['pattern'],
    );

    async execute(params: Record<string, unknown>): ReturnType<BaseTool['execute']> {
      const pattern = params.pattern as string;
      const basePath = (params.path as string) || workingDir;

      if (!pattern) return this.failure('pattern is required');

      const absPath = normalize(isAbsolute(basePath) ? basePath : resolve(workingDir, basePath));

      // Extract directory prefix from pattern (e.g. "src/main/**" → base + "src/main", pattern → "**")
      const { searchDir, effectivePattern } = extractDirFromPattern(absPath, pattern);

      // Security: prevent globbing outside working directory
      const workRoot = normalize(resolve(workingDir));
      if (!searchDir.startsWith(workRoot)) {
        return this.failure(`Cannot search outside working directory: ${searchDir}`);
      }

      try {
        const files = await findFiles(searchDir, effectivePattern);
        const relativeFiles = files.map((f) => relative(searchDir, f));

        if (relativeFiles.length === 0) {
          return this.success(`No files matching pattern: ${pattern}`);
        }

        // List first 100 results
        const display = relativeFiles.slice(0, 100);
        const suffix =
          relativeFiles.length > 100 ? `\n... and ${relativeFiles.length - 100} more files` : '';

        return this.success(
          `Found ${relativeFiles.length} files matching "${pattern}":\n${display.map((f) => `  ${f}`).join('\n')}${suffix}`,
        );
      } catch (error) {
        return this.failure(`Glob search failed: ${(error as Error).message}`);
      }
    }
  })();
}

/**
 * Simple glob-based file finder.
 * Supports ** for recursive matching, * for single-level wildcards.
 */
async function findFiles(rootDir: string, pattern: string, maxResults = 500): Promise<string[]> {
  const results: Array<{ path: string; mtime: number }> = [];
  const ignoreDirs = new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    'dist',
    'build',
    'out',
    '.next',
    '__pycache__',
    '.venv',
    'venv',
    'target',
    '.idea',
    '.vscode',
  ]);

  // Convert glob pattern to regex
  const regex = globToRegex(pattern);

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return;

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= maxResults) break;

        const fullPath = join(dir, entry.name);
        const relPath = relative(rootDir, fullPath);

        if (entry.isDirectory()) {
          if (!ignoreDirs.has(entry.name) && !entry.name.startsWith('.')) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          // Match against pattern
          const normalizedRel = relPath.split(sep).join('/');
          if (regex.test(normalizedRel)) {
            try {
              const info = await stat(fullPath);
              results.push({ path: fullPath, mtime: info.mtimeMs });
            } catch {
              results.push({ path: fullPath, mtime: 0 });
            }
          }
        }
      }
    } catch {
      // Permission denied or other error - skip this directory
    }
  }

  await walk(rootDir);

  // Sort by modification time (newest first)
  results.sort((a, b) => b.mtime - a.mtime);

  return results.slice(0, maxResults).map((r) => r.path);
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: ** (any depth), * (single level), ? (single char), {a,b} (alternatives)
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = '^';

  const parts = pattern.split('/');

  for (let i = 0; i < parts.length; i++) {
    if (i > 0) regexStr += '/';

    const part = parts[i];

    if (part === '**') {
      // Match any number of directory levels
      if (i === parts.length - 1) {
        // ** at the end matches everything
        regexStr += '.*';
      } else {
        regexStr += '(?:.*/)?';
      }
    } else {
      // Convert glob wildcards to regex
      let segRegex = '';
      for (let j = 0; j < part.length; j++) {
        const ch = part[j];
        switch (ch) {
          case '*':
            segRegex += '[^/]*';
            break;
          case '?':
            segRegex += '[^/]';
            break;
          case '{': {
            // Simple alternation {a,b,c}
            const close = part.indexOf('}', j);
            if (close > j) {
              const options = part.slice(j + 1, close).split(',');
              segRegex += `(?:${options.map(escapeRegex).join('|')})`;
              j = close;
            } else {
              segRegex += '\\{';
            }
            break;
          }
          case '.':
            segRegex += '\\.';
            break;
          default:
            if (/[.*+?^${}()|[\]\\]/.test(ch)) {
              segRegex += `\\${ch}`;
            } else {
              segRegex += ch;
            }
        }
      }
      regexStr += segRegex;
    }
  }

  regexStr += '$';
  return new RegExp(regexStr);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract a non-wildcard directory prefix from the glob pattern.
 * E.g. "src/main/**\/*.ts" → searchDir = "/abs/path/src/main", effectivePattern = "**\/*.ts"
 * This ensures the walk starts from the right directory and relative paths match correctly.
 */
function extractDirFromPattern(
  basePath: string,
  pattern: string,
): { searchDir: string; effectivePattern: string } {
  let searchDir = basePath;
  let effectivePattern = pattern;

  // Normalize separators
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const parts = normalizedPattern.split('/');

  // Walk until we hit a wildcard-containing segment
  let prefixEnd = 0;
  for (const part of parts) {
    if (part.includes('*') || part.includes('?') || part.includes('{')) break;
    prefixEnd++;
  }

  if (prefixEnd > 0) {
    const prefixPath = parts.slice(0, prefixEnd).join('/');
    searchDir = join(basePath, prefixPath);
    effectivePattern = parts.slice(prefixEnd).join('/') || '**';
  }

  return { searchDir, effectivePattern };
}
