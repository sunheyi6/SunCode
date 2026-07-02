import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** Base directory for all application data (sessions, runs, logs, stats). */
export function getAppDataDir(): string {
  const dir = join(app.getPath('userData'), '.suncode');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ── Legacy migration helpers ─────────────────────────────────────────────

/** Recursively merge src into dest. Files that already exist in dest are
 *  skipped (newer data wins). After merge, src is deleted. */
function mergeInto(src: string, dest: string): void {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }
  const entries = readdirSync(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      mergeInto(srcPath, destPath);
    } else if (!existsSync(destPath)) {
      try {
        // Prefer rename (atomic + fast on same volume), fall back to copy
        renameSync(srcPath, destPath);
      } catch {
        copyFileSync(srcPath, destPath);
        unlinkSync(srcPath);
      }
    }
  }
  // Remove src only when it's empty (all entries processed)
  try {
    rmdirSync(src);
  } catch {
    // Directory not empty — some files may have been skipped; leave it
  }
}

/**
 * Migrate legacy data from the install directory (process.cwd()/.suncode) to
 * the Electron userData directory. This keeps user sessions, settings and logs
 * safe even if the app is uninstalled or moved to a different install path.
 *
 * Runs once per legacy installation. Merges individual files so that any data
 * already written to the new location is preserved (newer data always wins).
 */
export function migrateLegacyDataDir(): void {
  const legacyDir = join(process.cwd(), '.suncode');
  const newDir = join(app.getPath('userData'), '.suncode');

  if (!existsSync(legacyDir) || legacyDir === newDir) {
    return;
  }

  try {
    mergeInto(legacyDir, newDir);
    console.log('[Paths] Merged legacy data dir:', legacyDir, '->', newDir);
  } catch (error) {
    console.error('[Paths] Failed to migrate legacy data dir:', (error as Error).message);
  }
}
