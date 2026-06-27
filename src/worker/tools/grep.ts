import type { ToolResult } from '@shared/types';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { resolve, isAbsolute, normalize, relative, basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { BaseTool, p, obj } from './types';

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

export function createGrepTool(workingDir: string) {
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

      // Security: prevent searching outside working directory
      if (!normalized.startsWith(resolve(workingDir))) {
        return this.failure(`Cannot search outside working directory: ${normalized}`);
      }

      // Determine if searchPath is a directory (for relative path formatting)
      let isDirectory = true;
      try {
        const info = await stat(normalized);
        isDirectory = info.isDirectory();
      } catch {
        return this.failure(`Path not found: ${normalized}`);
      }

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

        args.push('--', pattern, '.');

        let child: ReturnType<typeof spawn>;
        try {
          child = spawn('rg', args, {
            cwd: normalized,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (_err) {
          resolveResult(
            this.failure(
              'ripgrep (rg) is not installed. Install it from https://github.com/BurntSushi/ripgrep/releases\n' +
                'Or use glob + read to explore files, or bash with findstr/PowerShell Select-String instead.',
            ),
          );
          return;
        }

        child.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            resolveResult(
              this.failure(
                'ripgrep (rg) is not installed. Install it from https://github.com/BurntSushi/ripgrep/releases\n' +
                  'Alternatively, use glob to find files and read to inspect them.',
              ),
            );
          } else {
            resolveResult(this.failure(`Grep error: ${err.message}`));
          }
        });

        const rl = createInterface({ input: child.stdout! });
        let stderr = '';
        let matchCount = 0;
        let matchLimitReached = false;
        let linesTruncated = false;
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
              matches.push({ filePath, lineNumber, lineText });
            }
            if (matchCount >= effectiveLimit) {
              matchLimitReached = true;
              if (!child.killed) child.kill();
            }
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on('close', async (code) => {
          rl.close();

          if (code !== 0 && code !== 1 && matchCount === 0) {
            resolveResult(
              this.failure(
                `ripgrep not available. Please install ripgrep or use bash to run grep. Error: ${stderr || 'unknown'}`,
              ),
            );
            return;
          }

          if (matchCount === 0) {
            resolveResult(this.success('No matches found.'));
            return;
          }

          // Format matches with optional context lines
          const outputLines: string[] = [];
          for (const match of matches) {
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
              // Context mode: read file to get surrounding lines
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

          // Build truncation notices
          const notices: string[] = [];
          if (matchLimitReached) {
            notices.push(
              `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
            );
          }

          // Apply byte truncation
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
            output = `${truncation.content}

[${notices.join('. ')}]`;
          } else {
            output = truncation.content;
          }

          resolveResult(this.success(`Found ${matchCount} matches:\n\n${output}`));
        });
      });
    }
  })();
}
