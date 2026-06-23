import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron';
import { registerIpcHandlers } from './ipc-handlers';
import { WindowManager } from './window-manager';

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
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: nativeTheme.shouldUseDarkColors ? '#1e1e2e' : '#eff1f5',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#cdd6f4' : '#4c4f69',
      height: 38,
    },
  });
  win.setMenuBarVisibility(false);

  // Handle theme changes to update title bar overlay color
  nativeTheme.on('updated', () => {
    if (!win.isDestroyed()) {
      win.setTitleBarOverlay({
        color: nativeTheme.shouldUseDarkColors ? '#1e1e2e' : '#eff1f5',
        symbolColor: nativeTheme.shouldUseDarkColors ? '#cdd6f4' : '#4c4f69',
      });
    }
  });

  win.on('ready-to-show', () => {
    win.show();
    win.focus();
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(join(__dirname, '../../dist/index.html'));
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
app.whenReady().then(initApp);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  windowManager.cleanup();
});
