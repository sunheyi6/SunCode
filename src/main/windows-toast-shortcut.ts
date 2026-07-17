/**
 * Ensure Windows Start Menu shortcuts carry the correct AppUserModelId so
 * toast notifications activate this process instead of a stale Electron.lnk.
 *
 * Root cause we hit in the wild:
 * - Dev runs set AUMID `com.suncode.app` and Windows/Electron created
 *   `%APPDATA%\...\Start Menu\Programs\Electron.lnk` pointing at
 *   `node_modules/electron/dist/electron.exe` *with that AUMID*.
 * - The installed product's `SunCode.lnk` had no AUMID property.
 * - Toast click for production therefore resolved to Electron.lnk → bare
 *   electron.exe welcome page ("path-to-app").
 *
 * Fix: on every startup, (re)write our own shortcut with the right target +
 * AUMID, and remove a project-local Electron.lnk that still claims our AUMID.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, shell } from 'electron';
import { APP_USER_MODEL_ID, IS_DEV } from './app-identity';
import { logger } from './logger';

const START_MENU_PROGRAMS = join(
  process.env.APPDATA ?? '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
);

function shortcutContains(path: string, needle: string): boolean {
  try {
    const bytes = readFileSync(path);
    // .lnk property stores often keep AUMID as UTF-16LE
    const utf16 = Buffer.from(bytes).toString('utf16le');
    if (utf16.includes(needle)) return true;
    return bytes.toString('utf8').includes(needle);
  } catch {
    return false;
  }
}

/**
 * Remove Start Menu Electron.lnk when it steals our toast identity.
 * Historically Electron wrote Electron.lnk with AUMID `com.suncode.app`
 * (no .dev), so production toasts activated bare electron.exe.
 */
function removeStaleElectronShortcut(): void {
  if (!START_MENU_PROGRAMS) return;
  const electronLnk = join(START_MENU_PROGRAMS, 'Electron.lnk');
  if (!existsSync(electronLnk)) return;

  const projectMarker = join('SunCode', 'node_modules', 'electron');
  // Exact prod AUMID, or any com.suncode.* claim, or our repo's electron binary.
  const stealsOurAumid =
    shortcutContains(electronLnk, 'com.suncode.app') ||
    shortcutContains(electronLnk, 'com.suncode.app.dev');
  const isOurProjectElectron =
    shortcutContains(electronLnk, projectMarker) ||
    shortcutContains(electronLnk, 'D:\\project\\SunCode') ||
    shortcutContains(electronLnk, 'D:/project/SunCode');

  if (!stealsOurAumid && !isOurProjectElectron) {
    return;
  }

  try {
    unlinkSync(electronLnk);
    logger.info('[ToastShortcut] Removed stale Electron.lnk that hijacked toast activation');
  } catch (err) {
    logger.warn('[ToastShortcut] Failed to remove Electron.lnk', err);
  }
}

function buildShortcutArgs(): string {
  // Packaged: SunCode.exe is the full app — no extra args.
  if (app.isPackaged) return '';

  // Dev / defaultApp: electron.exe needs the app entry as argv[1].
  // Quote paths with spaces; skip argv[0] (execPath).
  const parts = process.argv.slice(1).filter((arg) => arg.length > 0);
  return parts.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ');
}

function writeShortcut(shortcutPath: string, options: Electron.ShortcutDetails): boolean {
  // Prefer delete + create so AUMID property store is not left stale on replace.
  if (existsSync(shortcutPath)) {
    try {
      unlinkSync(shortcutPath);
    } catch (err) {
      logger.warn('[ToastShortcut] Could not remove old shortcut before rewrite', err);
    }
  }
  if (shell.writeShortcutLink(shortcutPath, 'create', options)) return true;
  return shell.writeShortcutLink(shortcutPath, 'replace', options);
}

/**
 * Create or replace the Start Menu shortcut used for toast attribution.
 * Safe to call on every launch (idempotent).
 */
export function ensureWindowsToastShortcut(): void {
  if (process.platform !== 'win32') return;
  if (!START_MENU_PROGRAMS) {
    logger.warn('[ToastShortcut] APPDATA missing; skip shortcut ensure');
    return;
  }

  removeStaleElectronShortcut();

  const shortcutName = IS_DEV ? 'SunCode Dev.lnk' : 'SunCode.lnk';
  const shortcutPath = join(START_MENU_PROGRAMS, shortcutName);
  const target = process.execPath;
  const args = buildShortcutArgs();
  const cwd = app.isPackaged ? dirname(process.execPath) : process.cwd();
  const description = IS_DEV ? 'SunCode Dev' : 'SunCode';

  const options: Electron.ShortcutDetails = {
    target,
    args,
    cwd,
    description,
    appUserModelId: APP_USER_MODEL_ID,
    icon: target,
    iconIndex: 0,
  };

  try {
    const ok = writeShortcut(shortcutPath, options);
    if (!ok) {
      logger.warn('[ToastShortcut] writeShortcutLink returned false', {
        shortcutPath,
        aumid: APP_USER_MODEL_ID,
      });
      return;
    }

    const aumidEmbedded = shortcutContains(shortcutPath, APP_USER_MODEL_ID);
    logger.info('[ToastShortcut] Ensured Start Menu shortcut', {
      shortcutPath,
      target,
      args,
      aumid: APP_USER_MODEL_ID,
      aumidEmbedded,
    });
    if (!aumidEmbedded) {
      logger.warn(
        '[ToastShortcut] Shortcut written but AUMID string not found in .lnk — toast click may still mis-route',
        { shortcutPath, aumid: APP_USER_MODEL_ID },
      );
    }
  } catch (err) {
    logger.warn('[ToastShortcut] Failed to write Start Menu shortcut', err);
  }
}
