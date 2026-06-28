import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, normalize } from 'node:path';
import { BaseTool, p, obj } from './types';

export function createFindTool(workingDir: string) {
  return new (class FindTool extends BaseTool {
    readonly name = 'find';
    readonly isReadonly = true;
    readonly description =
      'Find files by name pattern. Searches recursively from the given directory. Supports case-insensitive matching and glob-style patterns.';
    readonly parameters = obj(
      {
        pattern: p('string', 'File name pattern to search for (e.g. "*.ts", "README", "config")'),
        path: p('string', 'Directory to search in (default: working directory)'),
        maxResults: p('integer', 'Maximum number of results (default: 50)'),
      },
      ['pattern'],
    );

    async execute(params: Record<string, unknown>): ReturnType<BaseTool['execute']> {
      const pattern = (params.pattern as string) || '';
      const searchPath = (params.path as string) || workingDir;
      const maxResults = (params.maxResults as number) || 50;

      if (!pattern) return this.failure('pattern is required');

      const absPath = normalize(isAbsolute(searchPath) ? searchPath : resolve(workingDir, searchPath));

      // Security: prevent searching outside working directory
      const workRoot = normalize(resolve(workingDir));
      if (!absPath.startsWith(workRoot)) {
        return this.failure(`Cannot search outside working directory: ${absPath}`);
      }

      try {
        const results = await findByName(absPath, pattern, maxResults);

        if (results.length === 0) {
          return this.success(`No files matching "${pattern}"`);
        }

        const display = results.map((f) => {
          const rel = relative(workRoot, f.path);
          return `  ${rel}${f.isDirectory ? '/' : ''}`;
        });

        const suffix =
          results.length >= maxResults ? `\n(max ${maxResults} results, may have more)` : '';
        return this.success(
          `Found ${results.length} file(s) matching "${pattern}":\n${display.join('\n')}${suffix}`,
        );
      } catch (error) {
        return this.failure(`Search failed: ${(error as Error).message}`);
      }
    }
  })();
}

interface FindResult {
  path: string;
  isDirectory: boolean;
}

async function findByName(
  rootDir: string,
  pattern: string,
  maxResults: number,
): Promise<FindResult[]> {
  const results: FindResult[] = [];

  // Convert glob/wildcard pattern to a matching function
  const matchFn = createNameMatcher(pattern);

  const ignoreDirs = new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    'dist',
    'build',
    '__pycache__',
    '.venv',
    'venv',
    'target',
    '.idea',
    '.vscode',
    'out',
  ]);

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return;

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith('.')) continue;

        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (matchFn(entry.name)) {
            results.push({ path: fullPath, isDirectory: true });
          }
          if (!ignoreDirs.has(entry.name)) {
            await walk(fullPath);
          }
        } else {
          if (matchFn(entry.name)) {
            results.push({ path: fullPath, isDirectory: false });
          }
        }
      }
    } catch {
      // Permission denied - skip
    }
  }

  await walk(rootDir);
  return results;
}

function createNameMatcher(pattern: string): (name: string) => boolean {
  // Case-insensitive matching
  const lowerPattern = pattern.toLowerCase();

  // Convert simple glob to function
  if (pattern.includes('*') || pattern.includes('?')) {
    const regexStr =
      '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$';
    const regex = new RegExp(regexStr, 'i');
    return (name: string) => regex.test(name);
  }

  // Simple substring match (case-insensitive)
  return (name: string) => name.toLowerCase().includes(lowerPattern);
}
