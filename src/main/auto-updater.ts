import type { UpdateStatus } from '@shared/types';
import { app } from 'electron';
import type { UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import pkg from 'electron-updater';
import type { WindowManager } from './window-manager';

const { autoUpdater } = pkg;

// ── Update source configuration ────────────────────────────────────────────
// Mirrors proxy GitHub Releases for users with slow/direct access to GitHub.
// They are tried in order; the official GitHub endpoint is the last resort.
// NOTE: keep owner/repo in sync with `electron-builder.yml` → publish.github.
const GITHUB_OWNER = 'sunheyi6';
const GITHUB_REPO = 'SunCode';
/** Base URL that hosts `latest.yml` and the release assets on GitHub. */
const GITHUB_RELEASES_BASE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/`;
/**
 * Reverse-proxy prefixes that prepend the full GitHub URL (prefix mode).
 * Only public releases are proxyable; draft releases need GitHub API + token.
 * Order = preference. Dead mirrors fall through automatically via the retry loop.
 */
const MIRROR_PREFIXES = [
  'https://ghproxy.net/',
  'https://ghfast.top/',
  'https://mirror.ghproxy.com/',
];

type FeedOptions = Parameters<typeof autoUpdater.setFeedURL>[0];

interface UpdateSource {
  name: string;
  /** Reconfigure autoUpdater to fetch updates from this source. */
  configure: () => void;
}

function makeMirrorSource(prefix: string): UpdateSource {
  const url = `${prefix}${GITHUB_RELEASES_BASE}`;
  return {
    name: `mirror(${prefix})`,
    configure: () => autoUpdater.setFeedURL({ provider: 'generic', url } as FeedOptions),
  };
}

function makeGitHubSource(): UpdateSource {
  return {
    name: 'github',
    configure: () =>
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
      } as FeedOptions),
  };
}

// Mirrors first, GitHub last.
const UPDATE_SOURCES: UpdateSource[] = [
  ...MIRROR_PREFIXES.map(makeMirrorSource),
  makeGitHubSource(),
];

// ── State ──────────────────────────────────────────────────────────────────
let windowManager: WindowManager;
let currentStatus: UpdateStatus = { state: 'idle' };
let isChecking = false;
let isDownloading = false;
/** Source that successfully reported the current update; reused for download. */
let activeSource: UpdateSource | null = null;
// Track skipped versions in-memory (persisted until app restart)
const skippedVersions = new Set<string>();

function broadcast(status: UpdateStatus): void {
  currentStatus = status;
  const win = windowManager?.getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:status', status);
  }
}

// ── Per-attempt helpers (temporary listeners, no global side effects) ──────

type CheckOutcome =
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'not-available' }
  | { kind: 'error'; error: Error };

function attemptCheck(): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: CheckOutcome): void => {
      if (settled) return;
      settled = true;
      autoUpdater.off('update-available', onAvailable);
      autoUpdater.off('update-not-available', onNotAvailable);
      autoUpdater.off('error', onError);
      resolve(r);
    };
    const onAvailable = (info: UpdateInfo): void => finish({ kind: 'available', info });
    const onNotAvailable = (): void => finish({ kind: 'not-available' });
    const onError = (err: Error): void => finish({ kind: 'error', error: err });

    autoUpdater.on('update-available', onAvailable);
    autoUpdater.on('update-not-available', onNotAvailable);
    autoUpdater.on('error', onError);

    autoUpdater.checkForUpdates().then(
      (result) => {
        if (!settled) {
          if (result?.isUpdateAvailable) finish({ kind: 'available', info: result.updateInfo });
          else finish({ kind: 'not-available' });
        }
      },
      (err: unknown) => finish({ kind: 'error', error: err as Error }),
    );
  });
}

type DownloadOutcome =
  | { kind: 'downloaded'; info: UpdateDownloadedEvent }
  | { kind: 'error'; error: Error };

function attemptDownload(): Promise<DownloadOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: DownloadOutcome): void => {
      if (settled) return;
      settled = true;
      autoUpdater.off('update-downloaded', onDownloaded);
      autoUpdater.off('error', onError);
      resolve(r);
    };
    const onDownloaded = (event: UpdateDownloadedEvent): void =>
      finish({ kind: 'downloaded', info: event });
    const onError = (err: Error): void => finish({ kind: 'error', error: err });

    autoUpdater.on('update-downloaded', onDownloaded);
    autoUpdater.on('error', onError);

    autoUpdater
      .downloadUpdate()
      .then(undefined, (err: unknown) => finish({ kind: 'error', error: err as Error }));
  });
}

function formatReleaseNotes(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes;
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (typeof n === 'string' ? n : ((n as { note?: string }).note ?? '')))
      .join('\n');
  }
  return undefined;
}

// ── Orchestration: try sources in order, fall back on failure ──────────────

async function runCheck(): Promise<void> {
  if (!app.isPackaged) {
    console.log('[Updater] Dev mode — ignoring check');
    return;
  }
  if (isChecking) {
    console.log('[Updater] Already checking — skipping duplicate check');
    return;
  }
  isChecking = true;
  broadcast({ state: 'checking' });

  let lastError: string | undefined;
  for (const source of UPDATE_SOURCES) {
    try {
      source.configure();
      const outcome = await attemptCheck();

      if (outcome.kind === 'available') {
        activeSource = source;
        isChecking = false;
        const info = outcome.info;
        if (info.version && skippedVersions.has(info.version)) {
          console.log('[Updater] Version', info.version, 'was skipped by user');
          broadcast({ state: 'no-update', skippedVersion: info.version });
          return;
        }
        console.log('[Updater] Update available via', source.name, ':', info.version);
        broadcast({
          state: 'update-available',
          version: info.version,
          releaseDate: info.releaseDate,
          releaseNotes: formatReleaseNotes(info),
        });
        return;
      }

      if (outcome.kind === 'not-available') {
        activeSource = source;
        isChecking = false;
        console.log(`[Updater] No update available (via ${source.name})`);
        broadcast({ state: 'no-update' });
        return;
      }

      // error → try next source
      lastError = outcome.error.message;
      console.warn(`[Updater] Source "${source.name}" failed: ${lastError}`);
    } catch (err) {
      lastError = (err as Error).message;
      console.warn(`[Updater] Source "${source.name}" threw: ${lastError}`);
    }
  }

  isChecking = false;
  console.error('[Updater] All update sources failed');
  broadcast({ state: 'error', error: lastError ?? 'All update sources failed' });
}

async function runDownload(): Promise<void> {
  if (isDownloading) {
    console.log('[Updater] Already downloading — skipping duplicate');
    return;
  }
  isDownloading = true;
  broadcast({ state: 'downloading', downloadProgress: 0 });

  // Start from the source that found the update, then fall back to the rest.
  const order: UpdateSource[] = activeSource
    ? [activeSource, ...UPDATE_SOURCES.filter((s) => s !== activeSource)]
    : UPDATE_SOURCES;

  let lastError: string | undefined;
  for (let i = 0; i < order.length; i++) {
    const source = order[i];
    try {
      source.configure();
      // The first source already has update metadata loaded from the check.
      // Fallback sources need a fresh (silent) check to load metadata for that provider.
      if (i > 0) {
        const co = await attemptCheck();
        if (co.kind !== 'available') {
          lastError =
            co.kind === 'error' ? co.error.message : `no update available via ${source.name}`;
          console.warn(`[Updater] Download fallback "${source.name}" check failed: ${lastError}`);
          continue;
        }
      }
      console.log('[Updater] Downloading via', source.name);
      const dl = await attemptDownload();
      if (dl.kind === 'downloaded') {
        isDownloading = false;
        console.log('[Updater] Update downloaded via', source.name, ':', dl.info.version);
        broadcast({
          state: 'downloaded',
          version: dl.info.version,
          releaseDate: dl.info.releaseDate,
        });
        return;
      }
      lastError = dl.error.message;
      console.warn(`[Updater] Download via "${source.name}" failed: ${lastError}`);
    } catch (err) {
      lastError = (err as Error).message;
      console.warn(`[Updater] Download via "${source.name}" threw: ${lastError}`);
    }
  }

  isDownloading = false;
  console.error('[Updater] Download failed from all sources');
  broadcast({ state: 'error', error: lastError ?? 'Download failed from all sources' });
}

// ── Public API ─────────────────────────────────────────────────────────────

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

  // Progress is broadcast live regardless of which source is active.
  autoUpdater.on('download-progress', (progress) => {
    broadcast({
      state: 'downloading',
      downloadProgress: progress.percent,
      downloadBytesPerSecond: progress.bytesPerSecond,
    });
  });

  // ── Start initial check (delayed so the window is ready) ──
  setTimeout(() => {
    runCheck();
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
  await runCheck();
}

export async function downloadUpdate(): Promise<void> {
  await runDownload();
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall();
}
