import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { loadSessionMetasFromDir } from '../../src/main/session-store';
import type { SessionMeta } from '../../src/shared/types';

function meta(id: string, updated: string): SessionMeta {
  return {
    id,
    name: id,
    created: updated,
    updated,
    messageCount: 1,
    workingDirectory: `D:\\project\\${id}`,
  };
}

describe('loadSessionMetasFromDir', () => {
  test('loads session list from file metadata without parsing the messages array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suncode-sessions-'));
    try {
      const older = meta('older', '2026-06-28T12:00:00.000Z');
      const newer = meta('newer', '2026-06-29T12:00:00.000Z');

      await writeFile(
        join(dir, 'older.json'),
        JSON.stringify({ meta: older, messages: 'this is intentionally not a message array' }, null, 2),
        'utf-8',
      );
      await writeFile(
        join(dir, 'newer.json'),
        `${JSON.stringify({ meta: newer }, null, 2).slice(0, -2)},\n  "messages": [`,
        'utf-8',
      );

      const sessions = await loadSessionMetasFromDir(dir);

      expect(sessions.map((session) => session.id)).toEqual(['newer', 'older']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
