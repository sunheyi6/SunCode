import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';
import { countLineChanges } from './line-diff';
import { BaseTool, obj, p } from './types';

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

      const absPath = isAbsolute(filePath) ? filePath : resolve(workingDir, filePath);
      const normalized = normalize(absPath);
      const failForTarget = (message: string) =>
        this.failure(message, {
          type: 'file_edit',
          filePath: normalized,
          status: 'failed',
          error: message,
        });

      if (oldString === undefined) return failForTarget('old_string is required');
      if (newString === undefined) return failForTarget('new_string is required');
      if (oldString === newString) {
        return failForTarget('old_string and new_string must be different');
      }

      // Security: prevent editing outside working directory
      if (!normalized.startsWith(resolve(workingDir))) {
        return failForTarget(`Cannot edit outside working directory: ${normalized}`);
      }

      try {
        const content = await readFile(normalized, 'utf-8');

        // Count occurrences
        const count = content.split(oldString).length - 1;

        if (count === 0) {
          const SNIPPET_MAX = 3000;
          const PREVIEW_LINES = 30;
          const lines = content.split('\n');
          const fileSnippet =
            content.length <= SNIPPET_MAX
              ? content
              : [
                  `[文件共 ${lines.length} 行，显示前 ${PREVIEW_LINES} 行]`,
                  ...lines.slice(0, PREVIEW_LINES),
                  `... 省略 ${lines.length - PREVIEW_LINES} 行`,
                ].join('\n');

          // Find the best-matching line for each non-empty line in old_string
          const oldLines = oldString.split('\n').filter((l) => l.trim());
          let bestMatchHint = '';
          for (const needle of oldLines) {
            const trimmed = needle.trim();
            if (trimmed.length < 5) continue;
            for (let i = 0; i < lines.length; i++) {
              const hay = lines[i].trim();
              if (hay === trimmed || (hay.length > 10 && hay.includes(trimmed))) {
                const ctxStart = Math.max(0, i - 2);
                const ctxEnd = Math.min(lines.length, i + 3);
                bestMatchHint = [
                  `\n[第 ${i + 1} 行附近找到相似内容:]`,
                  ...lines.slice(ctxStart, ctxEnd).map((l, j) => `  ${ctxStart + j + 1}: ${l}`),
                ].join('\n');
                break;
              }
            }
            if (bestMatchHint) break;
          }

          return failForTarget(
            [
              'old_string not found in file. The file may have been modified since you last read it.',
              '',
              '当前文件内容:',
              '```',
              fileSnippet,
              '```',
              bestMatchHint,
              '请基于上面的实际文件内容重新构造 old_string，或使用 write 替换整个文件。',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }

        if (count > 1 && !replaceAll) {
          return failForTarget(
            `old_string appears ${count} times in the file. Use replace_all: true to replace all occurrences, or make old_string more specific to match only one occurrence.`,
          );
        }

        const newContent = replaceAll
          ? content.split(oldString).join(newString)
          : content.replace(oldString, newString);

        const changes = countLineChanges(content, newContent);
        await writeFile(normalized, newContent, 'utf-8');

        // Extract context around the change for diff display (5 lines before/after)
        const oldIdx = content.indexOf(oldString);
        const oldLines = content.split('\n');
        const changedLineIdx = content.slice(0, oldIdx).split('\n').length - 1;
        const ctxStart = Math.max(0, changedLineIdx - 5);
        const ctxEnd = Math.min(oldLines.length, changedLineIdx + newString.split('\n').length + 5);
        const oldCtx = oldLines.slice(ctxStart, ctxEnd).join('\n');
        const newCtx = newContent
          .split('\n')
          .slice(ctxStart, ctxEnd + (newString.split('\n').length - oldString.split('\n').length))
          .join('\n');

        const replacementCount = replaceAll ? count : 1;
        return this.success(
          `Edit applied to ${normalized}\n${replacementCount} replacement(s) made.`,
          {
            type: 'file_edit',
            filePath: normalized,
            status: 'edited',
            ...changes,
            oldContent: oldCtx,
            newContent: newCtx,
          },
        );
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          return failForTarget(`File not found: ${normalized}`);
        }
        return failForTarget(`Failed to edit file: ${(error as Error).message}`);
      }
    }
  })();
}
