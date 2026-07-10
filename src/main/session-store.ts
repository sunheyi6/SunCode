import { existsSync, mkdirSync } from 'node:fs';
import { open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message, SessionMeta } from '@shared/types';
import { getAppDataDir } from './paths';

/** Root directory for session storage under the standard Electron userData path. */
function getSessionsDir(): string {
  const dir = join(getAppDataDir(), 'sessions');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

interface SessionFile {
  meta: SessionMeta;
  messages: Message[];
}

const SESSION_META_READ_CHUNK = 4096;
const SESSION_META_MAX_PREFIX = 64 * 1024;
const SESSION_META_READ_CONCURRENCY = 24;

/** Ensure the sessions directory exists. Call once on startup. */
export function initSessionStore(): void {
  void getSessionsDir();
}

/** File path for a session. */
function sessionPath(id: string): string {
  return join(getSessionsDir(), `${id}.json`);
}

/** Absolute path of the session file for the given session id. */
export function getSessionFilePath(id: string): string {
  return sessionPath(id);
}

/** Temp path used for atomic writes. */
function tempPath(id: string): string {
  return join(getSessionsDir(), `${id}.json.tmp`);
}

/** Load all sessions (metadata only, no messages). */
export async function loadAllSessions(): Promise<SessionMeta[]> {
  try {
    const sessionsDir = getSessionsDir();
    return await loadSessionMetasFromDir(sessionsDir);
  } catch {
    return [];
  }
}

export async function loadSessionMetasFromDir(sessionsDir: string): Promise<SessionMeta[]> {
  const entries = await readdir(sessionsDir);
  const jsonFiles = entries.filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
  const metas = await mapWithConcurrency(jsonFiles, SESSION_META_READ_CONCURRENCY, async (file) => {
    try {
      return await readSessionMetaFile(join(sessionsDir, file));
    } catch {
      console.warn(`[SessionStore] Skipping unreadable session file: ${file}`);
      return null;
    }
  });

  return metas
    .filter((meta): meta is SessionMeta => meta !== null)
    .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
}

async function readSessionMetaFile(path: string): Promise<SessionMeta | null> {
  const file = await open(path, 'r');
  try {
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    const buffer = Buffer.allocUnsafe(SESSION_META_READ_CHUNK);
    let position = 0;

    while (position < SESSION_META_MAX_PREFIX) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;

      chunks.push(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
      position += bytesRead;

      const meta = extractSessionMeta(chunks.join(''));
      if (meta) return meta;
    }

    chunks.push(decoder.decode());
    return extractSessionMeta(chunks.join(''));
  } finally {
    await file.close();
  }
}

function extractSessionMeta(raw: string): SessionMeta | null {
  const keyIndex = raw.indexOf('"meta"');
  if (keyIndex < 0) return null;

  const colonIndex = raw.indexOf(':', keyIndex + 6);
  if (colonIndex < 0) return null;

  const objectStart = raw.indexOf('{', colonIndex + 1);
  if (objectStart < 0) return null;

  const objectEnd = findJsonObjectEnd(raw, objectStart);
  if (objectEnd < 0) return null;

  try {
    const parsed = JSON.parse(raw.slice(objectStart, objectEnd + 1)) as Partial<SessionMeta>;
    return isSessionMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findJsonObjectEnd(raw: string, objectStart: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = objectStart; i < raw.length; i++) {
    const char = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function isSessionMeta(value: Partial<SessionMeta>): value is SessionMeta {
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.created === 'string' &&
    typeof value.updated === 'string' &&
    typeof value.messageCount === 'number' &&
    typeof value.workingDirectory === 'string'
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex++;
      results[index] = await mapper(items[index] as T);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Load a full session including messages.

 * If maxMessages is specified AND the file is large, only the last N messages
 * are extracted from the pretty-printed JSON (written by JSON.stringify with
 * 2-space indent), avoiding the O(n) cost of parsing the full message array.
 * For small files (under 50KB), the full parse is used — JSON.parse is fast
 * enough that custom parsing adds more complexity than value.
 */
export async function loadSession(id: string, maxMessages?: number): Promise<SessionFile | null> {
  const path = sessionPath(id);
  try {
    if (!existsSync(path)) return null;

    // For large files with maxMessages, extract only the tail of the messages
    // array using the predictable pretty-print format.
    if (maxMessages !== undefined) {
      return await loadSessionTail(path, id, maxMessages);
    }

    // Full load — parse everything
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as SessionFile;
  } catch {
    console.warn(`[SessionStore] Failed to load session: ${id}`);
    return null;
  }
}

/** Threshold: files under this size use full JSON.parse. */
const FULL_PARSE_SIZE_LIMIT = 50 * 1024;

/**
 * Load a session file but only parse the last `maxMessages` messages
 * from the pretty-printed JSON array. Messages in pretty-print format
 * (JSON.stringify with 2-space indent) start with `    {` on their own
 * line after a comma, making them easy to find by scanning backwards.
 */
async function loadSessionTail(
  path: string,
  id: string,
  maxMessages: number,
): Promise<SessionFile | null> {
  try {
    const { stat } = await import('node:fs/promises');
    const fileStat = await stat(path);

    // Small files: just full parse
    if (fileStat.size < FULL_PARSE_SIZE_LIMIT) {
      const raw = await readFile(path, 'utf-8');
      const data = JSON.parse(raw) as SessionFile;
      if (data.messages.length > maxMessages) {
        data.messages = data.messages.slice(-maxMessages);
      }
      return data;
    }

    // Large file: read all, then parse tail-only
    const raw = await readFile(path, 'utf-8');

    // Find the messages array boundaries
    const msgKeyIdx = raw.indexOf('"messages"');
    if (msgKeyIdx < 0) {
      // No messages key — fallback to full parse
      const data = JSON.parse(raw) as SessionFile;
      if (data.messages.length > maxMessages) {
        data.messages = data.messages.slice(-maxMessages);
      }
      return data;
    }

    const arrStart = raw.indexOf('[', msgKeyIdx);
    const arrEnd = raw.lastIndexOf(']');
    if (arrStart < 0 || arrEnd <= arrStart) {
      // Malformed array — fallback
      const data = JSON.parse(raw) as SessionFile;
      if (data.messages.length > maxMessages) {
        data.messages = data.messages.slice(-maxMessages);
      }
      return data;
    }

    // Extract meta: everything before the messages array, re-close as JSON
    const metaText = raw.slice(0, arrStart).replace(/,\s*$/, '');
    let meta: SessionMeta;
    try {
      meta = (JSON.parse(`${metaText}}`) as { meta: SessionMeta }).meta;
    } catch {
      // Meta parse failed — fallback
      const data = JSON.parse(raw) as SessionFile;
      if (data.messages.length > maxMessages) {
        data.messages = data.messages.slice(-maxMessages);
      }
      return data;
    }

    // Extract messages: use split-by-boundary for pretty-printed JSON
    // Pretty-print format: each message object ends with "  }," or "  }"
    // and the next message starts a new line:
    //   {
    //     "id": ...
    //   },
    //   {
    //     "id": ...
    //   }
    const arrayContent = raw.slice(arrStart + 1, arrEnd).trim();

    // Try: count brace-depth to find individual objects
    const messages = extractTailMessages(arrayContent, maxMessages);

    // If extraction fails or returns wrong count, fall back
    if (messages.length === 0 && maxMessages > 0) {
      // Fallback
      const data = JSON.parse(raw) as SessionFile;
      if (data.messages.length > maxMessages) {
        data.messages = data.messages.slice(-maxMessages);
      }
      return { meta, messages: data.messages };
    }

    return { meta, messages: messages.slice(-maxMessages) };
  } catch {
    console.warn(`[SessionStore] Failed to load tail for session: ${id}`);
    return null;
  }
}

/**
 * Extract the last `count` message objects from a JSON array content string
 * (content between [ and ]). Uses brace-depth scanning from the end to find
 * object boundaries — reliable for any nesting depth.
 */
function extractTailMessages(arrayContent: string, count: number): Message[] {
  const messages: Message[] = [];
  let pos = arrayContent.length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objEnd = -1;

  while (pos >= 0 && messages.length < count) {
    const ch = arrayContent[pos];

    if (escaped) {
      escaped = false;
    } else if (inString) {
      if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '}' || ch === ']') {
      if (depth === 0) objEnd = pos;
      depth++;
    } else if (ch === '{' || ch === '[') {
      depth--;
      if (depth === 0 && ch === '{') {
        // Found a complete object — extract and parse
        try {
          const objText = arrayContent.slice(pos, objEnd + 1);
          messages.unshift(JSON.parse(objText) as Message);
        } catch {
          // Skip malformed object
        }
        objEnd = -1;
      }
    }

    pos--;
  }

  return messages;
}

/** Return a bounded tail without changing the source message array. */
export function limitMessages(messages: Message[], maxMessages?: number): Message[] {
  if (maxMessages === undefined || messages.length <= maxMessages) return messages;
  if (maxMessages <= 0) return [];
  return messages.slice(-maxMessages);
}

/** Save a session to disk atomically (write .tmp → rename). */
export async function saveSession(meta: SessionMeta, messages: Message[]): Promise<void> {
  const data: SessionFile = { meta, messages };
  const json = JSON.stringify(data, null, 2);

  const tmp = tempPath(meta.id);
  const dest = sessionPath(meta.id);

  await writeFile(tmp, json, 'utf-8');
  await rename(tmp, dest);
}

/** Delete a session file. */
export async function deleteSession(id: string): Promise<void> {
  const path = sessionPath(id);
  try {
    if (existsSync(path)) {
      await unlink(path);
    }
    // Also clean up any stale tmp file
    const tmp = tempPath(id);
    if (existsSync(tmp)) {
      await unlink(tmp);
    }
    // Also clean up run directories
    await deleteRunDirs(id);
  } catch {
    console.warn(`[SessionStore] Failed to delete session: ${id}`);
  }
}

/** Delete multiple sessions at once. */
export async function deleteSessions(ids: string[]): Promise<void> {
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const path = sessionPath(id);
      if (existsSync(path)) {
        await unlink(path);
      }
      const tmp = tempPath(id);
      if (existsSync(tmp)) {
        await unlink(tmp);
      }
      await deleteRunDirs(id);
    }),
  );
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      console.warn(`[SessionStore] Failed to delete session: ${ids[i]}`);
    }
  }
}

/** Remove run directories associated with a session. */
async function deleteRunDirs(sessionId: string): Promise<void> {
  try {
    const runsDir = join(getSessionsDir(), sessionId);
    if (existsSync(runsDir)) {
      await rmrf(runsDir);
    }
  } catch {
    // best-effort cleanup
  }
}

/** Recursive rmdir using Node fs/promises. */
async function rmrf(dirPath: string): Promise<void> {
  const { readdir, rmdir, unlink, stat } = await import('node:fs/promises');
  const entries = await readdir(dirPath);
  for (const entry of entries) {
    const full = join(dirPath, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      await rmrf(full);
    } else {
      await unlink(full);
    }
  }
  await rmdir(dirPath);
}
