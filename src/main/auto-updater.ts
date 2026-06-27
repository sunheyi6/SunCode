import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '@shared/types';
import type { WindowManager } from './window-manager';

let windowManager: WindowManager;
let currentStatus: UpdateStatus = { state: 'idle' };
let isChecking = false;

// Track skipped versions in-memory (persisted until app restart)
const skippedVersions = new Set<string>();

function broadcast(status: UpdateStatus): void {
  currentStatus = status;
  const win = windowManager?.getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:status', status);
  }
}

export function initAutoUpdater(wm: WindowManager): void {
  windowManager = wm;

  // Skip in dev mode
  if (!app.isPackaged) {
    console.log('[Updater] Dev mode — skipping update checks');
    return;
  }

  // Skip for portable builds (Windows only)
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    console.log('[Updater] Portable mode — skipping update checks');
    return;
  }

  // Configure autoUpdater
  autoUpdater.autoDownload = false;
  autoUpdater.allowDowngrade = false;

  // ── Event handlers ──

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for updates...');
    isChecking = true;
    broadcast({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Update available:', info.version);
    isChecking = false;

    // Skip if user dismissed this version
    if (info.version && skippedVersions.has(info.version)) {
      console.log('[Updater] Version', info.version, 'was skipped by user');
      broadcast({ state: 'no-update', skippedVersion: info.version });
      return;
    }

    broadcast({
      state: 'update-available',
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes:
        typeof info.releaseNotes === 'string'
          ? info.releaseNotes
          : Array.isArray(info.releaseNotes)
            ? info.releaseNotes
                .map((n) => (typeof n === 'string' ? n : (n as { note?: string }).note ?? ''))
                .join('\n')
            : undefined,
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] No update available');
    isChecking = false;
    broadcast({ state: 'no-update' });
  });

  autoUpdater.on('download-progress', (progress) => {
    broadcast({
      state: 'downloading',
      downloadProgress: progress.percent,
      downloadBytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Update downloaded:', info.version);
    broadcast({
      state: 'downloaded',
      version: info.version,
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message);
    isChecking = false;
    broadcast({
      state: 'error',
      error: err.message || 'Unknown error during update check',
    });
  });

  // ── Start initial check (delayed so the window is ready) ──
  setTimeout(() => {
    checkForUpdates();
  }, 5000);
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus;
}

export function skipVersion(version: string): void {
  skippedVersions.add(version);
  broadcast({ ...currentStatus, skippedVersion: version });
}

export async function checkForUpdates(): Promise<void> {
  if (isChecking) {
    console.log('[Updater] Already checking — skipping duplicate check');
    return;
  }
  if (!app.isPackaged) {
    console.log('[Updater] Dev mode — ignoring check');
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.error('[Updater] checkForUpdates failed:', (err as Error).message);
    // Error already handled by the 'error' event listener
  }
}

export async function downloadUpdate(): Promise<void> {
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    console.error('[Updater] downloadUpdate failed:', (err as Error).message);
  }
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall();
}
