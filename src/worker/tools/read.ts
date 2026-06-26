import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, isAbsolute, normalize, relative } from 'node:path';
import { BaseTool, p, obj } from './types';

export function createReadTool(workingDir: string) {
  return new (class ReadTool extends BaseTool {
    readonly name = 'read';
    isReadonly = true;
    readonly description =
      'Reads a file or directory. For files: returns contents with line numbers. For directories: lists entries. Supports reading images (PNG, JPG, GIF, WEBP) as base64. Specify offset/limit for large files.';
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

      // Security: prevent reading outside working directory
      if (!normalized.startsWith(resolve(workingDir))) {
        return this.failure(`Cannot read outside working directory: ${normalized}`);
      }

      try {
        const info = await stat(normalized);

        // Handle directories: list contents instead of error
        if (info.isDirectory()) {
          const entries = await readdir(normalized, { withFileTypes: true });
          const dirs = entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`);
          const files = entries.filter((e) => e.isFile()).map((e) => e.name);
          const listing = [...dirs.sort(), ...files.sort()].map((name) => `  ${name}`).join('\n');
          return this.success(
            `Directory: ${normalized}\n\n${listing || '  (empty)'}\n\n${entries.length} entries. Use read with a file path to read file contents.`,
          );
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
          const dir = relative(resolve(workingDir), normalized);
          return this.failure(
            `File not found: ${normalized}. Use glob with pattern like "${dir.split(/[\\/]/).slice(0, -1).join('/')}/**/*" to find files in that directory.`,
          );
        }
        return this.failure(`Failed to read file: ${(error as Error).message}`);
      }
    }
  })();
}
