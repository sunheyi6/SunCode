import { BrowserWindow } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Manages application windows: main window + settings window.
 */
export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private settingsWindow: BrowserWindow | null = null;

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;

    win.on('closed', () => {
      this.mainWindow = null;
    });
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  showSettingsWindow(): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.focus();
      return;
    }

    this.settingsWindow = new BrowserWindow({
      width: 600,
      height: 500,
      title: 'SunCode Settings',
      parent: this.mainWindow || undefined,
      modal: true,
      resizable: false,
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const settingsHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Settings</title>
        <style>
          body { font-family: system-ui; background: #1e1e2e; color: #cdd6f4; padding: 20px; }
          h2 { color: #89b4fa; }
          .info { color: #a6adc8; }
        </style>
      </head>
      <body>
        <h2>SunCode Settings</h2>
        <p class="info">Settings can be configured through the in-app settings panel.</p>
      </body>
      </html>
    `;
    this.settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(settingsHtml)}`);

    this.settingsWindow.on('closed', () => {
      this.settingsWindow = null;
    });
  }

  cleanup(): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.close();
    }
  }
}
