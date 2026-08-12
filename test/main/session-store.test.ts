import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import {
  limitMessages,
  loadSessionMetasFromDir,
  loadSessionTailFromFile,
} from '../../src/main/session-store';
import type { Message, SessionMeta } from '../../src/shared/types';

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

describe('limitMessages', () => {
  test('returns only the requested tail without changing the source array', () => {
    const source = Array.from({ length: 12 }, (_, index) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: String(index) }],
    }));

    const limited = limitMessages(source, 10);

    expect(limited.map((message) => message.content)).toHaveLength(10);
    expect(limited[0]?.content).toEqual([{ type: 'text', text: '2' }]);
    expect(source).toHaveLength(12);
    expect(limitMessages(source, 0)).toEqual([]);
  });
});

describe('loadSessionTailFromFile', () => {
  test('reads a valid tail without parsing an unrelated malformed prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suncode-session-tail-'));
    const path = join(dir, 'large.json');
    try {
      const sessionMeta = meta('large', '2026-08-12T12:00:00.000Z');
      const tail: Message[] = Array.from({ length: 12 }, (_, index) => ({
        role: 'user',
        content: [{ type: 'text', text: `message ${index}: quote \\" and brace }` }],
      }));
      const prefix = `${JSON.stringify({ meta: sessionMeta }, null, 2).slice(0, -2)},\n  "messages": [\n    ${'x'.repeat(70 * 1024)},\n`;
      const validTail = tail.map((message) => JSON.stringify(message, null, 4)).join(',\n');
      await writeFile(path, `${prefix}${validTail}\n  ]\n}\n`, 'utf-8');

      const snapshot = await loadSessionTailFromFile(path, 10);

      expect(snapshot?.meta).toEqual(sessionMeta);
      expect(snapshot?.messages).toHaveLength(10);
      expect(snapshot?.messages[0]?.content).toEqual([
        { type: 'text', text: 'message 2: quote \\" and brace }' },
      ]);
      expect(snapshot?.messages.at(-1)?.content).toEqual([
        { type: 'text', text: 'message 11: quote \\" and brace }' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
