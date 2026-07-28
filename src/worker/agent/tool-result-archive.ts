/**
 * Tool-result archive — durable raw bodies for context prune recovery.
 *
 * Contract: archive-before-omit. Callers must keep the original provider
 * message when this module fails to return a non-empty artifactId.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolResultArchiveRecord } from '@shared/types';

export function hashToolResultBody(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Persist a full tool-result body. Stable artifactId is content-addressed by
 * toolCallId + bodySha256 so retries reuse the same file after integrity check.
 */
export function archiveToolResultBody(
  archiveDir: string | undefined,
  toolCallId: string,
  content: string,
): ToolResultArchiveRecord | undefined {
  if (!archiveDir) return undefined;

  const bodySha256 = hashToolResultBody(content);
  const originalBytes = Buffer.byteLength(content, 'utf8');
  const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const artifactId = `${safeId}_${bodySha256.slice(0, 32)}`;
  const absolutePath = join(archiveDir, `${artifactId}.txt`);

  try {
    mkdirSync(archiveDir, { recursive: true });

    if (existsSync(absolutePath)) {
      const existing = readFileSync(absolutePath);
      const existingHash = createHash('sha256').update(existing).digest('hex');
      if (existingHash === bodySha256 && existing.byteLength === originalBytes) {
        return { artifactId, bodySha256, originalBytes, absolutePath };
      }
      // Collision with different content — refuse to overwrite silently.
      console.warn(
        `[ToolResultArchive] Hash mismatch for existing archive ${artifactId}; keeping original tool result`,
      );
      return undefined;
    }

    writeFileSync(absolutePath, content, 'utf8');
    return { artifactId, bodySha256, originalBytes, absolutePath };
  } catch (error) {
    console.warn(
      `[ToolResultArchive] Failed to archive tool result ${toolCallId}:`,
      (error as Error).message,
    );
    return undefined;
  }
}
