import { readFile, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute, normalize } from 'node:path';
import { BaseTool, p, obj } from './types';

export function createEditTool(workingDir: string) {
  return new (class EditTool extends BaseTool {
    readonly name = 'edit';
    readonly description =
      'Performs exact string replacement in an existing file. Fails if old_string is not unique in the file. Use replace_all: true to replace every occurrence. The old_string must match the file content exactly, including indentation and whitespace.';
    readonly parameters = obj(
      {
        file_path: p('string', 'The absolute path to the file to modify'),
        old_string: p('string', 'The text to replace (must match exactly, including whitespace)'),
        new_string: p('string', 'The text to replace it with (must be different from old_string)'),
        replace_all: p('boolean', 'Replace all occurrences instead of just the first one'),
      },
      ['file_path', 'old_string', 'new_string'],
    );

    async execute(params: Record<string, unknown>): Promise<ReturnType<BaseTool['execute']>> {
      const filePath = params.file_path as string;
      const oldString = params.old_string as string;
      const newString = params.new_string as string;
      const replaceAll = Boolean(params.replace_all);

      if (!filePath) return this.failure('file_path is required');
      if (oldString === undefined) return this.failure('old_string is required');
      if (newString === undefined) return this.failure('new_string is required');
      if (oldString === newString) {
        return this.failure('old_string and new_string must be different');
      }

      const absPath = isAbsolute(filePath) ? filePath : resolve(workingDir, filePath);
      const normalized = normalize(absPath);

      try {
        const content = await readFile(normalized, 'utf-8');

        // Count occurrences
        const count = content.split(oldString).length - 1;

        if (count === 0) {
          return this.failure(
            `old_string not found in file. Make sure the string matches exactly, including whitespace and indentation.`,
          );
        }

        if (count > 1 && !replaceAll) {
          return this.failure(
            `old_string appears ${count} times in the file. Use replace_all: true to replace all occurrences, or make old_string more specific to match only one occurrence.`,
          );
        }

        const newContent = replaceAll
          ? content.split(oldString).join(newString)
          : content.replace(oldString, newString);

        await writeFile(normalized, newContent, 'utf-8');

        const replacementCount = replaceAll ? count : 1;
        return this.success(
          `Edit applied to ${normalized}\n${replacementCount} replacement(s) made.`,
        );
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          return this.failure(`File not found: ${normalized}`);
        }
        return this.failure(`Failed to edit file: ${(error as Error).message}`);
      }
    }
  })();
}
