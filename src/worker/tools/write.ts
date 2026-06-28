import type { ToolResult } from '@shared/types';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { withFileMutationQueue } from './file-mutation-queue';
import { countLineChanges } from './line-diff';
import { BaseTool, obj, p } from './types';
import { isSensitiveFile } from './sensitive';

export function createWriteTool(workingDir: string) {
  return new (class WriteTool extends BaseTool {
    readonly name = 'write';
    readonly description =
      'Writes a file to the local filesystem. Creates parent directories if they do not exist. Overwrites the file if it already exists. Returns a success message.';
    readonly parameters = obj(
      {
        file_path: p('string', 'The absolute path to the file to write'),
        content: p('string', 'The content to write to the file'),
      },
      ['file_path', 'content'],
    );

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const filePath = params.file_path as string;
      const content = params.content as string;

      if (!filePath) return this.failure('file_path is required');

      const absPath = isAbsolute(filePath) ? filePath : resolve(workingDir, filePath);
      const normalized = normalize(absPath);
      const failForTarget = (message: string) =>
        this.failure(message, {
          type: 'file_edit',
          filePath: normalized,
          status: 'failed',
          error: message,
        });

      if (content === undefined) return failForTarget('content is required');

      // Security: prevent writing outside working directory
      if (!normalized.startsWith(resolve(workingDir))) {
        return failForTarget(`Cannot write outside working directory: ${normalized}`);
      }

      // Security: block sensitive files (credentials, keys, etc.)
      if (isSensitiveFile(normalized)) {
        return failForTarget(
          `Cannot write sensitive file: ${normalized}. This file may contain credentials or secrets.`,
        );
      }

      try {
        return await withFileMutationQueue(normalized, async () => {
          let oldContent = '';
          try {
            oldContent = await readFile(normalized, 'utf-8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }

          // Create parent directories
          await mkdir(dirname(normalized), { recursive: true });

          // Write the file
          await writeFile(normalized, content, 'utf-8');

          const changes = countLineChanges(oldContent, content);
          return this.success(
            `File written successfully: ${normalized}\n${changes.addedLines} added, ${changes.removedLines} removed`,
            {
              type: 'file_edit',
              filePath: normalized,
              status: 'edited',
              ...changes,
              oldContent,
              newContent: content,
            },
          );
        });
      } catch (error) {
        return failForTarget(`Failed to write file: ${(error as Error).message}`);
      }
    }
  })();
}
