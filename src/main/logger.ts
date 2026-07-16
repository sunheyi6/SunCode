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
import { APP_RUNTIME_IDENTITY, IS_DEV } from './app-identity';
import { getAppDataDir } from './paths';

// ── Resolve log path to <userData>/.suncode/app.log ───────────────────
const LOG_DIR = getAppDataDir();
const LOG_PATH = join(LOG_DIR, 'app.log');

log.transports.file.resolvePathFn = () => LOG_PATH;
log.transports.file.fileName = 'app.log';
log.transports.file.maxSize = 2 * 1024 * 1024; // 2 MB before rotation → app.old.log
log.transports.file.level = IS_DEV ? 'debug' : 'info';
log.variables.appMode = APP_RUNTIME_IDENTITY.appMode;
log.variables.appVersion = APP_RUNTIME_IDENTITY.appVersion;
log.variables.mainPid = String(APP_RUNTIME_IDENTITY.mainPid);
log.variables.appInstanceId = APP_RUNTIME_IDENTITY.appInstanceId;
log.transports.file.format =
  '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] [{appMode} v{appVersion} pid={mainPid} instance={appInstanceId}]{scope} {text}';

// Console transport: verbose in dev (terminal-attached), reduced in production
log.transports.console.level = IS_DEV ? 'debug' : 'warn';

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
