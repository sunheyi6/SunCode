import { readFile, stat } from 'node:fs/promises';
import { resolve, isAbsolute, normalize } from 'node:path';
import { BaseTool, p, obj } from './types';

export function createReadTool(workingDir: string) {
  return new (class ReadTool extends BaseTool {
    readonly name = 'read';
    readonly description =
      'Reads a file from the local filesystem. Returns the file contents with line numbers. Supports reading images (PNG, JPG, GIF, WEBP) as base64. Specify offset/limit for large files.';
    readonly parameters = obj(
      {
        file_path: p('string', 'The absolute path to the file to read'),
        offset: p('integer', 'The line number to start reading from (default: 1)'),
        limit: p('integer', 'The number of lines to read (default: all)'),
      },
      ['file_path'],
    );

    async execute(params: Record<string, unknown>): Promise<ReturnType<BaseTool['execute']>> {
      const filePath = params.file_path as string;
      const offset = (params.offset as number) || 0;
      const limit = params.limit as number | undefined;

      if (!filePath) {
        return this.failure('file_path is required');
      }

      const absPath = isAbsolute(filePath) ? filePath : resolve(workingDir, filePath);
      const normalized = normalize(absPath);

      try {
        const info = await stat(normalized);

        // Handle directories
        if (info.isDirectory()) {
          return this.failure(`Path is a directory, not a file: ${normalized}`);
        }

        // Handle image files
        const ext = normalized.split('.').pop()?.toLowerCase();
        const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
        if (ext && imageExts.includes(ext)) {
          const buffer = await readFile(normalized);
          const base64 = buffer.toString('base64');
          const mimeMap: Record<string, string> = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
          };
          return this.success(
            `[Image: ${normalized}]\nMIME: ${mimeMap[ext] || 'application/octet-stream'}\nBase64 (${(base64.length / 1024).toFixed(1)} KB):\n${base64}`,
          );
        }

        // Read text file
        const content = await readFile(normalized, 'utf-8');
        const lines = content.split('\n');

        const startLine = Math.max(0, offset - 1);
        const endLine = limit ? startLine + limit : lines.length;
        const selectedLines = lines.slice(startLine, endLine);

        // Format with line numbers
        const formatted = selectedLines
          .map((line, i) => `${String(startLine + i + 1).padStart(4, ' ')}  ${line}`)
          .join('\n');

        const header =
          limit || offset
            ? `File: ${normalized} (lines ${startLine + 1}-${Math.min(endLine, lines.length)} of ${lines.length})\n\n`
            : `File: ${normalized} (${lines.length} lines)\n\n`;

        return this.success(header + formatted);
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          return this.failure(`File not found: ${normalized}`);
        }
        return this.failure(`Failed to read file: ${(error as Error).message}`);
      }
    }
  })();
}
