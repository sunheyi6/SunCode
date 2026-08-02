import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ToolResult } from '@shared/types';
import { resolveToolExecutionEnvironment, type ToolExecutionEnvironment } from './bash';
import { globToRegex } from './glob';
import { BaseTool, obj, p } from './types';

/** Maximum output bytes before truncation. */
const DEFAULT_MAX_BYTES = 50_000;
/** Maximum characters per line before truncation. */
const GREP_MAX_LINE_LENGTH = 500;
/** Default match limit. */
const DEFAULT_LIMIT = 100;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Truncate a single line if it exceeds maxLength. */
function truncateLine(
  line: string,
  maxLength = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxLength) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, maxLength)}…`, wasTruncated: true };
}

/** Truncate output text to fit within maxBytes, preserving line boundaries. */
function truncateHead(
  text: string,
  options: { maxBytes?: number; maxLines?: number },
): { content: string; truncated: boolean; maxBytes: number } {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? Number.MAX_SAFE_INTEGER;
  const lines = text.split('\n');
  if (lines.length <= maxLines && Buffer.byteLength(text, 'utf-8') <= maxBytes) {
    return { content: text, truncated: false, maxBytes };
  }
  const result: string[] = [];
  let byteCount = 0;
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + 1; // +1 for newline
    if (byteCount + lineBytes > maxBytes && result.length > 0) break;
    result.push(lines[i]);
    byteCount += lineBytes;
  }
  return {
    content: result.join('\n') + (result.length < lines.length ? '\n... (truncated)' : ''),
    truncated: true,
    maxBytes,
  };
}

export function createGrepTool(
  workingDir: string,
  executionEnvironment: ToolExecutionEnvironment = resolveToolExecutionEnvironment(),
) {
  return new (class GrepTool extends BaseTool {
    readonly name = 'grep';
    isReadonly = true;
    readonly description =
      'Searches for a regular expression pattern in file contents using ripgrep. Supports full regex, file type filtering, context lines, and more. Prefer this over running `grep` or `rg` via bash. Output is truncated to 100 matches or 50KB (whichever is hit first).';
    readonly parameters = obj(
      {
        pattern: p('string', 'The regular expression or literal pattern to search for'),
        path: p('string', 'File or directory to search in (default: working directory)'),
        glob: p('string', 'Glob pattern to filter files (e.g. "*.ts", "*.{js,ts}")'),
        ignoreCase: p('boolean', 'Case insensitive search (default: false)'),
        literal: p('boolean', 'Treat pattern as literal string instead of regex (default: false)'),
        context: p('integer', 'Number of lines to show before and after each match (default: 0)'),
        limit: p('integer', 'Maximum number of matches to return (default: 100)'),
        multiline: p('boolean', 'Enable multiline mode (default: false)'),
        type: p(
          'string',
          'File type to search (e.g. "js", "py", "rust", "ts"). More efficient than glob.',
        ),
      },
      ['pattern'],
    );

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const pattern = params.pattern as string;
      const searchPath = (params.path as string) || workingDir;
      const glob = params.glob as string | undefined;
      const ignoreCase = Boolean(params.ignoreCase);
      const literal = Boolean(params.literal);
      const contextVal = (params.context as number) || 0;
      const effectiveLimit = Math.max(1, (params.limit as number) || DEFAULT_LIMIT);
      const multiline = Boolean(params.multiline);
      const fileType = params.type as string | undefined;

      if (!pattern) return this.failure('pattern is required');

      const absPath = isAbsolute(searchPath) ? searchPath : resolve(workingDir, searchPath);
      const normalized = normalize(absPath);

      // Determine if searchPath is a directory (for relative path formatting)
      let isDirectory = true;
      try {
        const info = await stat(normalized);
        isDirectory = info.isDirectory();
      } catch {
        return this.failure(`Path not found: ${normalized}`);
      }
      const processCwd = isDirectory ? normalized : dirname(normalized);
      const searchTarget = isDirectory ? '.' : basename(normalized);

      const formatPath = (filePath: string): string => {
        if (isDirectory) {
          const rel = relative(normalized, filePath);
          if (rel && !rel.startsWith('..')) return rel.replace(/\\/g, '/');
        }
        return basename(filePath);
      };

      // File content cache for context line reads
      const fileCache = new Map<string, string[]>();
      const getFileLines = async (filePath: string): Promise<string[]> => {
        let lines = fileCache.get(filePath);
        if (!lines) {
          try {
            const content = await readFile(filePath, 'utf-8');
            lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
          } catch {
            lines = [];
          }
          fileCache.set(filePath, lines);
        }
        return lines;
      };

      return new Promise((resolveResult) => {
        const self = this;
        let matchCount = 0;
        let matchLimitReached = false;
        let linesTruncated = false;
        let fallbackTried = false;

        /** Format collected matches into the output string. */
        async function formatMatches(
          matchesList: Array<{ filePath: string; lineNumber: number; lineText?: string }>,
        ): Promise<string> {
          const outputLines: string[] = [];
          for (const match of matchesList) {
            if (contextVal === 0 && match.lineText !== undefined) {
              const relativePath = formatPath(match.filePath);
              const sanitized = match.lineText
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '')
                .replace(/\n$/, '');
              const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
              if (wasTruncated) linesTruncated = true;
              outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
            } else {
              const relativePath = formatPath(match.filePath);
              const fileLines = await getFileLines(match.filePath);
              if (!fileLines.length) {
                outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
                continue;
              }
              const block: string[] = [];
              const ctxStart =
                contextVal > 0 ? Math.max(1, match.lineNumber - contextVal) : match.lineNumber;
              const ctxEnd =
                contextVal > 0
                  ? Math.min(fileLines.length, match.lineNumber + contextVal)
                  : match.lineNumber;
              for (let cur = ctxStart; cur <= ctxEnd; cur++) {
                const lineText = fileLines[cur - 1] ?? '';
                const sanitized = lineText.replace(/\r/g, '');
                const isMatchLine = cur === match.lineNumber;
                const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                if (wasTruncated) linesTruncated = true;
                if (isMatchLine) {
                  block.push(`${relativePath}:${cur}: ${truncatedText}`);
                } else {
                  block.push(`${relativePath}-${cur}- ${truncatedText}`);
                }
              }
              outputLines.push(...block);
            }
          }
          let output = outputLines.join('\n');
          const notices: string[] = [];
          if (matchLimitReached) {
            notices.push(
              `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
            );
          }
          const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES });
          if (truncation.truncated) {
            notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
          }
          if (linesTruncated) {
            notices.push(
              `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
            );
          }
          if (notices.length > 0) {
            output = `${truncation.content}\n\n[${notices.join('. ')}]`;
          } else {
            output = truncation.content;
          }
          return output;
        }

        /** Fallback that does not depend on any executable being installed. */
        async function runNativeGrepFallback(): Promise<void> {
          if (fallbackTried) return;
          fallbackTried = true;
          matchCount = 0;
          matchLimitReached = false;
          linesTruncated = false;
          const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
          const source = literal ? pattern.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') : pattern;
          let matcher: RegExp;
          try {
            matcher = new RegExp(
              source,
              multiline ? `gmsu${ignoreCase ? 'i' : ''}` : `u${ignoreCase ? 'i' : ''}`,
            );
          } catch (error) {
            resolveResult(self.failure(`Invalid regular expression: ${(error as Error).message}`));
            return;
          }

          const globMatcher = glob ? globToRegex(glob.replace(/\\/g, '/')) : undefined;
          const typeExtensions: Record<string, string[]> = {
            js: ['.js', '.jsx', '.mjs', '.cjs'],
            ts: ['.ts', '.tsx', '.mts', '.cts'],
            py: ['.py', '.pyi'],
            rust: ['.rs'],
            go: ['.go'],
            java: ['.java'],
            json: ['.json', '.jsonl'],
            yaml: ['.yaml', '.yml'],
          };
          const extensions = fileType
            ? (typeExtensions[fileType.toLowerCase()] ?? [`.${fileType.toLowerCase()}`])
            : undefined;
          const ignoredDirectories = new Set([
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
          ]);

          const acceptsFile = (filePath: string): boolean => {
            if (
              extensions &&
              !extensions.some((extension) => filePath.toLowerCase().endsWith(extension))
            ) {
              return false;
            }
            if (!globMatcher) return true;
            const relativePath = relative(normalized, filePath).replace(/\\/g, '/');
            const globTarget = glob?.includes('/') ? relativePath : basename(filePath);
            return globMatcher.test(globTarget);
          };

          const scanFile = async (filePath: string): Promise<void> => {
            if (matchCount >= effectiveLimit || !acceptsFile(filePath)) return;
            let content: string;
            try {
              content = await readFile(filePath, 'utf-8');
            } catch {
              return;
            }
            if (content.includes('\0')) return;
            const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

            if (multiline) {
              matcher.lastIndex = 0;
              let match = matcher.exec(normalizedContent);
              while (match !== null) {
                const lineNumber = normalizedContent.slice(0, match.index).split('\n').length;
                const lineText = normalizedContent.split('\n')[lineNumber - 1] ?? '';
                matches.push({ filePath, lineNumber, lineText });
                matchCount++;
                if (matchCount >= effectiveLimit) {
                  matchLimitReached = true;
                  break;
                }
                if (match[0].length === 0) matcher.lastIndex++;
                match = matcher.exec(normalizedContent);
              }
              return;
            }

            const lines = normalizedContent.split('\n');
            for (let index = 0; index < lines.length; index++) {
              matcher.lastIndex = 0;
              if (!matcher.test(lines[index])) continue;
              matches.push({ filePath, lineNumber: index + 1, lineText: lines[index] });
              matchCount++;
              if (matchCount >= effectiveLimit) {
                matchLimitReached = true;
                break;
              }
            }
          };

          const walk = async (directory: string): Promise<void> => {
            if (matchCount >= effectiveLimit) return;
            const entries = await readdir(directory, { withFileTypes: true }).catch(
              () => undefined,
            );
            if (!entries) return;
            for (const entry of entries) {
              if (matchCount >= effectiveLimit) break;
              const filePath = join(directory, entry.name);
              if (entry.isDirectory()) {
                if (!ignoredDirectories.has(entry.name)) await walk(filePath);
              } else if (entry.isFile()) {
                await scanFile(filePath);
              }
            }
          };

          try {
            if (isDirectory) await walk(normalized);
            else await scanFile(normalized);
          } catch (error) {
            resolveResult(self.failure(`Native grep failed: ${(error as Error).message}`));
            return;
          }

          if (matchCount === 0) {
            resolveResult(self.success('No matches found.'));
            return;
          }
          const output = await formatMatches(matches);
          resolveResult(
            self.success(
              `Found ${matchCount} matches (used built-in scan — rg unavailable):\n\n${output}`,
            ),
          );
        }

        // Build ripgrep arguments
        const args: string[] = [
          '--json',
          '--line-number',
          '--color=never',
          '--hidden',
          '--no-require-git',
        ];

        if (multiline) {
          args.push('--multiline', '--multiline-dotall');
        }
        if (ignoreCase) {
          args.push('--ignore-case');
        }
        if (literal) {
          args.push('--fixed-strings');
        }
        if (glob) {
          args.push('--glob', glob);
        }
        if (fileType) {
          args.push('--type', fileType);
        }

        args.push('--', pattern, searchTarget);

        let child: ReturnType<typeof spawn>;
        try {
          child = spawn('rg', args, {
            cwd: processCwd,
            env: executionEnvironment.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (_err) {
          // rg not available, fall through to the built-in scanner.
          void runNativeGrepFallback();
          return;
        }

        child.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // rg binary not found, fall back to the built-in scanner.
            void runNativeGrepFallback();
          } else {
            resolveResult(this.failure(`Grep error: ${err.message}`));
          }
        });

        if (!child.stdout) {
          void runNativeGrepFallback();
          return;
        }
        const rl = createInterface({ input: child.stdout });
        let _stderr = '';
        const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];

        rl.on('line', (line) => {
          if (!line.trim() || matchCount >= effectiveLimit) return;
          let event: Record<string, unknown> | undefined;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event?.type === 'match') {
            matchCount++;
            const data = event.data as Record<string, unknown> | undefined;
            const filePath = (data?.path as Record<string, unknown>)?.text as string;
            const lineNumber = data?.line_number as number | undefined;
            const lineText = (data?.lines as Record<string, unknown>)?.text as string;
            if (filePath && typeof lineNumber === 'number') {
              matches.push({
                filePath: resolve(processCwd, filePath),
                lineNumber,
                lineText,
              });
            }
            if (matchCount >= effectiveLimit) {
              matchLimitReached = true;
              if (!child.killed) child.kill();
            }
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          _stderr += chunk.toString();
        });

        child.on('close', async (code) => {
          rl.close();

          if ((code !== 0 && code !== 1) || (code !== 0 && matchCount === 0)) {
            // rg failed, fall back to the built-in scanner.
            void runNativeGrepFallback();
            return;
          }

          if (matchCount === 0) {
            resolveResult(this.success('No matches found.'));
            return;
          }

          // Format matches with optional context lines
          const output = await formatMatches(matches);
          resolveResult(this.success(`Found ${matchCount} matches:\n\n${output}`));
        });
      });
    }
  })();
}
