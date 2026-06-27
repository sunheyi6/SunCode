import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron';
import { registerIpcHandlers } from './ipc-handlers';
import { WindowManager } from './window-manager';
import { initAutoUpdater } from './auto-updater';
import { logger, getLogPath } from './logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Single-instance lock ────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running — quit immediately
  app.quit();
} else {
  // Focus the existing window when a second instance is launched
  app.on('second-instance', () => {
    const mainWindow = windowManager?.getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

let windowManager: WindowManager;

const isMac = process.platform === 'darwin';

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'SunCode',
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e2e' : '#eff1f5',
    autoHideMenuBar: true,
    show: false,
    // macOS only: hide native title bar with overlay color control
    // On Windows, keeping the default title bar avoids rendering issues
    ...(isMac
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: nativeTheme.shouldUseDarkColors ? '#1e1e2e' : '#eff1f5',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#cdd6f4' : '#4c4f69',
            height: 38,
          },
        }
      : {}),
  });
  win.setMenuBarVisibility(false);

  // macOS: Handle theme changes to update title bar overlay color
  if (isMac) {
    nativeTheme.on('updated', () => {
      if (!win.isDestroyed()) {
        win.setTitleBarOverlay({
          color: nativeTheme.shouldUseDarkColors ? '#1e1e2e' : '#eff1f5',
          symbolColor: nativeTheme.shouldUseDarkColors ? '#cdd6f4' : '#4c4f69',
        });
      }
    });
  }

  // ── Safety: if ready-to-show never fires (e.g. renderer crash during
  //     load), force-show the window after a timeout so the user at least
  //     sees a blank/error page instead of a silent dead process.
  const READY_TIMEOUT_MS = 12_000;
  const readyTimeout = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      logger.warn('[Window] ready-to-show timed out after %d ms — forcing show', READY_TIMEOUT_MS);
      win.show();
    }
  }, READY_TIMEOUT_MS);

  win.on('ready-to-show', () => {
    clearTimeout(readyTimeout);
    logger.info('[Window] ready-to-show');
    win.show();
    win.focus();
  });

  // ── Renderer failure diagnostics ────────────────────────────────────
  // These are the key signals that tell us WHY the window never appeared.

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.error('[Window] Page load failed', {
      errorCode,
      errorDescription,
      validatedURL,
    });
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('[Window] Render process gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  win.on('unresponsive', () => {
    logger.warn('[Window] Unresponsive — page may be hung');
  });

  // Capture renderer console errors (only errors, not all logs)
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) {
      // 0=verbose, 1=info, 2=warning, 3=error
      logger.warn('[Renderer] %s', message);
    }
  });

  // ── Load the app ─────────────────────────────────────────────────────
  if (process.env.VITE_DEV_SERVER_URL) {
    logger.info('[Window] Loading dev URL: %s', process.env.VITE_DEV_SERVER_URL);
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const htmlPath = join(__dirname, '../../dist/index.html');
    logger.info('[Window] Loading file: %s', htmlPath);
    win.loadFile(htmlPath);
  }

  // Open external links in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  return win;
}

async function initApp(): Promise<void> {
  // Create the window manager
  windowManager = new WindowManager();

  // Register IPC handlers
  registerIpcHandlers(windowManager);

  // All application options live in the in-app settings panel.
  Menu.setApplicationMenu(null);

  // Initialize auto-updater (no-op in dev/portable mode)
  initAutoUpdater(windowManager);

  // Create the main window
  const mainWindow = createMainWindow();
  windowManager.setMainWindow(mainWindow);

  // macOS: re-create window when dock icon clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createMainWindow();
      windowManager.setMainWindow(win);
    }
  });
}

// App lifecycle
logger.info('[App] Starting SunCode', {
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  logPath: getLogPath(),
  cwd: process.cwd(),
  isPackaged: app.isPackaged,
});

app.whenReady().then(() => {
  logger.info('[App] ready, initializing...');
  return initApp();
}).then(() => {
  logger.info('[App] Init complete');
}).catch((err) => {
  logger.error('[App] Init failed', err);
});

app.on('window-all-closed', () => {
  logger.info('[App] All windows closed');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  logger.info('[App] before-quit, running cleanup');
  windowManager.cleanup();
});

app.on('quit', () => {
  logger.info('[App] quit');
});

// ── GPU / child-process crash diagnostics ───────────────────────────────
// Catches GPU process crashes, which can silently kill the app on Windows.
// type: 'GPU' | 'Utility' | 'Zygote' | 'Sandbox helper' | etc.
app.on('child-process-gone', (_event, details) => {
  logger.error('[App] Child process gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName,
    name: details.name,
  });
});
