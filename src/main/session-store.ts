import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message, SessionMeta } from '@shared/types';

/** Root directory for session storage, relative to the project. */
const SESSIONS_DIR = join(process.cwd(), '.suncode', 'sessions');

interface SessionFile {
  meta: SessionMeta;
  messages: Message[];
}

/** Ensure the sessions directory exists. Call once on startup. */
export function initSessionStore(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

/** File path for a session. */
function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

/** Temp path used for atomic writes. */
function tempPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json.tmp`);
}

/** Load all sessions (metadata only, no messages). */
export async function loadAllSessions(): Promise<SessionMeta[]> {
  try {
    const entries = await readdir(SESSIONS_DIR);
    const jsonFiles = entries.filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));

    const metas: SessionMeta[] = [];
    for (const file of jsonFiles) {
      try {
        const raw = await readFile(join(SESSIONS_DIR, file), 'utf-8');
        const data = JSON.parse(raw) as SessionFile;
        if (data.meta?.id) {
          metas.push(data.meta);
        }
      } catch {
        // Skip corrupt or unreadable session files
        console.warn(`[SessionStore] Skipping unreadable session file: ${file}`);
      }
    }
    return metas.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
  } catch {
    return [];
  }
}

/** Load a full session including messages. */
export async function loadSession(id: string): Promise<SessionFile | null> {
  const path = sessionPath(id);
  try {
    if (!existsSync(path)) return null;
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as SessionFile;
  } catch {
    console.warn(`[SessionStore] Failed to load session: ${id}`);
    return null;
  }
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
  } catch {
    console.warn(`[SessionStore] Failed to delete session: ${id}`);
  }
}
