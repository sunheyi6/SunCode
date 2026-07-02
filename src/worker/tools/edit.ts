import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';
import type { ToolResult } from '@shared/types';
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from './edit-diff';
import { withFileMutationQueue } from './file-mutation-queue';
import { countLineChanges } from './line-diff';
import { isSensitiveFile } from './sensitive';
import { BaseTool, obj, p } from './types';

export function createEditTool(workingDir: string) {
  return new (class EditTool extends BaseTool {
    readonly name = 'edit';
    readonly description =
      'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.';
    readonly parameters = obj(
      {
        file_path: p('string', 'Path to the file to edit (relative or absolute)'),
        edits: p(
          'array',
          'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.',
          {
            items: {
              type: 'object',
              properties: {
                oldText: {
                  type: 'string',
                  description:
                    'Exact text for one targeted replacement. Must be unique in the file and not overlap with other edits.',
                },
                newText: {
                  type: 'string',
                  description: 'Replacement text for this targeted edit.',
                },
              },
              required: ['oldText', 'newText'],
            },
          },
        ),
        // Legacy single-edit parameters (backward compat)
        old_string: p('string', '[Legacy] Single replacement — use edits[] instead.'),
        new_string: p('string', '[Legacy] Replacement text for old_string.'),
        replace_all: p('boolean', '[Legacy] Replace all occurrences of old_string.'),
      },
      ['file_path', 'edits'],
    );

    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const filePath = (params.file_path || params.path) as string;
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

      // Normalize edits: accept both legacy (old_string/new_string) and new (edits[]) format
      const edits = normalizeEditParams(params);
      if (!edits || edits.length === 0) {
        return failForTarget(
          'No edits provided. Use edits: [{oldText, newText}] or old_string + new_string.',
        );
      }

      // Security: prevent editing outside working directory
      if (!normalized.startsWith(resolve(workingDir))) {
        return failForTarget(`Cannot edit outside working directory: ${normalized}`);
      }

      // Security: block sensitive files (credentials, keys, etc.)
      if (isSensitiveFile(normalized)) {
        return failForTarget(
          `Cannot edit sensitive file: ${normalized}. This file may contain credentials or secrets.`,
        );
      }

      try {
        return await withFileMutationQueue(normalized, async () => {
          // Read the file
          let buffer: Buffer;
          try {
            buffer = await readFile(normalized);
          } catch (error) {
            if ((error as { code?: string }).code === 'ENOENT') {
              return failForTarget(`File not found: ${normalized}`);
            }
            throw error;
          }

          const rawContent = buffer.toString('utf-8');

          // Strip BOM before matching — the LLM won't include invisible BOM in oldText
          const { bom, text: content } = stripBom(rawContent);

          // Detect original line endings and normalize to LF for matching
          const originalEnding = detectLineEnding(content);
          const normalizedContent = normalizeToLF(content);

          // Apply all edits against the original (LF-normalized) content
          const { baseContent, newContent } = applyEditsToNormalizedContent(
            normalizedContent,
            edits,
            normalized,
          );

          // Restore original line endings and prepend BOM
          const finalContent = bom + restoreLineEndings(newContent, originalEnding);

          await writeFile(normalized, finalContent, 'utf-8');

          const changes = countLineChanges(content, finalContent);

          // Extract context around the first change for diff display (5 lines before/after)
          const firstEdit = edits[0];
          const oldIdx = baseContent.indexOf(normalizeToLF(firstEdit.oldText));
          const oldLines = baseContent.split('\n');
          const changedLineIdx =
            oldIdx >= 0 ? baseContent.slice(0, oldIdx).split('\n').length - 1 : 0;
          const ctxStart = Math.max(0, changedLineIdx - 5);
          const ctxEnd = Math.min(
            oldLines.length,
            changedLineIdx + firstEdit.newText.split('\n').length + 5,
          );
          const oldCtx = oldLines.slice(ctxStart, ctxEnd).join('\n');
          const newCtx = newContent
            .split('\n')
            .slice(
              ctxStart,
              ctxEnd +
                (firstEdit.newText.split('\n').length - firstEdit.oldText.split('\n').length),
            )
            .join('\n');

          return this.success(
            `Successfully applied ${edits.length} edit(s) to ${normalized}\n${changes.addedLines} added, ${changes.removedLines} removed`,
            {
              type: 'file_edit',
              filePath: normalized,
              status: 'edited',
              ...changes,
              oldContent: oldCtx,
              newContent: newCtx,
            },
          );
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          return failForTarget(`File not found: ${normalized}`);
        }
        return failForTarget(`Failed to edit file: ${(error as Error).message}`);
      }
    }
  })();
}

/**
 * Normalize edit parameters, accepting both legacy (old_string/new_string/replace_all)
 * and new (edits: [{oldText, newText}]) formats.
 */
function normalizeEditParams(params: Record<string, unknown>): Edit[] | null {
  // New format: edits array
  if (Array.isArray(params.edits) && params.edits.length > 0) {
    const edits: Edit[] = [];
    for (const e of params.edits) {
      if (
        e &&
        typeof e === 'object' &&
        typeof (e as Edit).oldText === 'string' &&
        typeof (e as Edit).newText === 'string'
      ) {
        edits.push({ oldText: (e as Edit).oldText, newText: (e as Edit).newText });
      }
    }
    if (edits.length > 0) return edits;
  }

  // Legacy format: old_string + new_string
  const oldString = params.old_string as string | undefined;
  const newString = params.new_string as string | undefined;
  const replaceAll = Boolean(params.replace_all);

  if (typeof oldString === 'string' && typeof newString === 'string') {
    if (oldString === newString) return null;
    // Legacy replace_all: for simplicity, we treat it as a single edit.
    // Full replace_all support would require expanding occurrences into individual edits.
    if (replaceAll) {
      // For replace_all, we'll handle it at a higher level... but for now,
      // single edit with replace_all=true is treated as a normal single edit.
      // Full support can be added later.
    }
    return [{ oldText: oldString, newText: newString }];
  }

  return null;
}
