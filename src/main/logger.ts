/**
 * App-level structured logger powered by electron-log.
 *
 * Writes to `<userData>/.suncode/app.log` — same directory as session data
 * and diagnostic logs, so everything is together under the standard Electron
 * user data folder.
 *
 * Automatically captures uncaught exceptions and unhandled rejections.
 * Log files rotate when they exceed ~2 MB (archived to app.old.log).
 *
 * Usage:
 *   import { logger } from './logger';
 *   logger.info('[App] Starting up');
 *   logger.error('[App] Failed to load', err);
 */

import { join } from 'node:path';
import log from 'electron-log/main';
import { getAppDataDir } from './paths';

// ── Resolve log path to <userData>/.suncode/app.log ───────────────────
const LOG_DIR = getAppDataDir();
const LOG_PATH = join(LOG_DIR, 'app.log');

log.transports.file.resolvePathFn = () => LOG_PATH;
log.transports.file.fileName = 'app.log';
log.transports.file.maxSize = 2 * 1024 * 1024; // 2 MB before rotation → app.old.log
log.transports.file.level = 'info';

// Console transport (dev only — terminal-attached in dev; no-op in production)
log.transports.console.level = 'info';

// Initialize electron-log (sets up process error hooks + console forwarding)
log.initialize();

// ── Additional error capture (belt and suspenders) ────────────────────
// electron-log's initialize() already hooks these, but we add explicit
// handlers so the error message is written BEFORE the process may exit.
process.on('uncaughtException', (error) => {
  log.error('[Process] uncaughtException', error);
  console.error('[App] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('[Process] unhandledRejection', reason);
  console.error('[App] Unhandled rejection:', reason);
});

// ── Public API ─────────────────────────────────────────────────────────

/** Absolute path to the current log file. */
export function getLogPath(): string {
  return LOG_PATH;
}

/** Re-export the scoped electron-log instance for direct use. */
export const logger = log;
