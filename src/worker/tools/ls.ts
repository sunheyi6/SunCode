import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { BaseTool, p, obj } from './types';

export function createLsTool(workingDir: string) {
  return new (class LsTool extends BaseTool {
    readonly name = 'ls';
    readonly isReadonly = true;
    readonly description =
      'List directory contents. Shows files and subdirectories with size and modification time. Supports recursive listing.';
    readonly parameters = obj(
      {
        path: p('string', 'Directory path to list (default: working directory)'),
        recursive: p('boolean', 'List recursively (default: false)'),
        limit: p('integer', 'Maximum number of entries (default: 100)'),
      },
      [],
    );

    async execute(params: Record<string, unknown>): ReturnType<BaseTool['execute']> {
      const dirPath = (params.path as string) || workingDir;
      const recursive = params.recursive === true;
      const limit = (params.limit as number) || 100;

      const absPath = normalizePath(isAbsolute(dirPath) ? dirPath : resolve(workingDir, dirPath));
      const workRoot = normalizePath(resolve(workingDir));

      // Security: prevent listing outside working directory
      if (!absPath.startsWith(workRoot)) {
        return this.failure(`Cannot list directory outside working directory: ${absPath}`);
      }

      try {
        const entries = await listDir(absPath, recursive, limit);

        if (entries.length === 0) {
          return this.success(`(empty directory)\n`);
        }

        const display = entries.slice(0, limit).map((entry) => {
          const type = entry.isDirectory ? '📁' : '📄';
          const size = entry.isDirectory ? '' : `  ${formatSize(entry.size)}`;
          const time = entry.mtime
            ? `  ${new Date(entry.mtime).toISOString().slice(0, 16).replace('T', ' ')}`
            : '';
          return `${type} ${entry.path}${size}${time}`;
        });

        const suffix =
          entries.length > limit ? `\n... and ${entries.length - limit} more entries` : '';
        return this.success(`${display.join('\n')}${suffix}`);
      } catch (error) {
        return this.failure(`Failed to list directory: ${(error as Error).message}`);
      }
    }
  })();
}

interface DirEntry {
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

async function listDir(rootDir: string, recursive: boolean, limit: number): Promise<DirEntry[]> {
  const results: DirEntry[] = [];
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
  ]);

  async function walk(dir: string, prefix: string): Promise<void> {
    if (results.length >= limit) return;

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= limit) break;
        if (entry.name.startsWith('.') && entry.name !== '.gitkeep') continue;

        const fullPath = join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          try {
            const info = await stat(fullPath);
            results.push({ path: relPath + '/', isDirectory: true, size: 0, mtime: info.mtimeMs });
          } catch {
            results.push({ path: relPath + '/', isDirectory: true, size: 0, mtime: 0 });
          }

          if (recursive && !ignoreDirs.has(entry.name)) {
            await walk(fullPath, relPath);
          }
        } else {
          try {
            const info = await stat(fullPath);
            results.push({
              path: relPath,
              isDirectory: false,
              size: info.size,
              mtime: info.mtimeMs,
            });
          } catch {
            results.push({ path: relPath, isDirectory: false, size: 0, mtime: 0 });
          }
        }
      }
    } catch {
      // Permission denied or other error - skip
    }
  }

  const baseName = rootDir.split(/[/\\]/).pop() || '';
  await walk(rootDir, '');
  return results;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Normalize path separators to forward slashes for consistent comparison. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}
