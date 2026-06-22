import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, isAbsolute, normalize, dirname } from 'node:path';
import { BaseTool, p, obj } from './types';

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

    async execute(params: Record<string, unknown>): Promise<ReturnType<BaseTool['execute']>> {
      const filePath = params.file_path as string;
      const content = params.content as string;

      if (!filePath) return this.failure('file_path is required');
      if (content === undefined) return this.failure('content is required');

      const absPath = isAbsolute(filePath) ? filePath : resolve(workingDir, filePath);
      const normalized = normalize(absPath);

      // Security: prevent writing outside working directory
      if (!normalized.startsWith(resolve(workingDir))) {
        return this.failure(`Cannot write outside working directory: ${normalized}`);
      }

      try {
        // Create parent directories
        await mkdir(dirname(normalized), { recursive: true });

        // Write the file
        await writeFile(normalized, content, 'utf-8');

        const lines = content.split('\n').length;
        const size = Buffer.byteLength(content, 'utf-8');
        return this.success(
          `File written successfully: ${normalized}\n${lines} lines, ${size} bytes`,
        );
      } catch (error) {
        return this.failure(`Failed to write file: ${(error as Error).message}`);
      }
    }
  })();
}
