import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
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

/** Ensure the sessions directory exists. Call once on startup. */
export function initSessionStore(): void {
  void getSessionsDir();
}

/** File path for a session. */
function sessionPath(id: string): string {
  return join(getSessionsDir(), `${id}.json`);
}

/** Temp path used for atomic writes. */
function tempPath(id: string): string {
  return join(getSessionsDir(), `${id}.json.tmp`);
}

/** Load all sessions (metadata only, no messages). */
export async function loadAllSessions(): Promise<SessionMeta[]> {
  try {
    const sessionsDir = getSessionsDir();
    const entries = await readdir(sessionsDir);
    const jsonFiles = entries.filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));

    const metas: SessionMeta[] = [];
    for (const file of jsonFiles) {
      try {
        const raw = await readFile(join(sessionsDir, file), 'utf-8');
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
