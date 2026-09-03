import { DEFAULT_SETTINGS } from '@shared/constants';
import type { AppSettings, WorkerInMessage } from '@shared/types';
import { type BrowserWindow, ipcMain } from 'electron';
import { getProviderEnvKey } from '../../shared/provider-env';

export interface SettingsIpcDependencies {
  getSettings: () => AppSettings;
  setSettings: (settings: AppSettings) => void;
  saveSettings: (settings: AppSettings) => Promise<void>;
  sendToWorker: (message: WorkerInMessage) => void;
  getMainWindow: () => BrowserWindow | null;
}

/** Register settings IPC separately from the main handler registry. */
export function registerSettingsIpcHandlers(deps: SettingsIpcDependencies): void {
  ipcMain.handle('settings:get', async () => {
    try {
      return deps.getSettings();
    } catch (error) {
      console.error('[Main] settings:get failed:', (error as Error).message);
      return { ...DEFAULT_SETTINGS };
    }
  });

  ipcMain.handle('settings:update', async (_event, partial: Partial<AppSettings>) => {
    try {
      const settings = {
        ...deps.getSettings(),
        ...partial,
        permissionMode: 'full_access' as const,
      };
      if (partial.envApiKeys) {
        for (const [provider, key] of Object.entries(partial.envApiKeys)) {
          const envKey = getProviderEnvKey(provider);
          if (envKey && key) process.env[envKey] = key;
        }
      }

      deps.setSettings(settings);
      deps.sendToWorker({ type: 'config', settings });
      deps.getMainWindow()?.webContents.send('settings:changed', settings);
      await deps.saveSettings(settings);
      return settings;
    } catch (error) {
      console.error('[Main] settings:update failed:', (error as Error).message);
      return deps.getSettings();
    }
  });

  ipcMain.handle('settings:setApiKey', async (_event, provider: string, key: string) => {
    try {
      const envKey = getProviderEnvKey(provider);
      if (envKey) process.env[envKey] = key;
      const settings = deps.getSettings();
      settings.envApiKeys[provider] = key;
      deps.setSettings(settings);
      deps.sendToWorker({ type: 'config', settings });
      await deps.saveSettings(settings);
      return true;
    } catch (error) {
      console.error('[Main] settings:setApiKey failed:', (error as Error).message);
      return false;
    }
  });

  ipcMain.handle('settings:getApiKeys', async () => {
    try {
      const keys: Record<string, string> = {};
      for (const provider of Object.keys(deps.getSettings().envApiKeys)) {
        const envKey = getProviderEnvKey(provider);
        keys[provider] = envKey ? process.env[envKey] || '' : '';
      }
      return keys;
    } catch (error) {
      console.error('[Main] settings:getApiKeys failed:', (error as Error).message);
      return {};
    }
  });
}
