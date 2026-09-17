import { RECOMMENDED_MODELS } from '@shared/constants';
import { modelCatalog, modelInfo } from '@shared/model-catalog';
import { ipcMain } from 'electron';

export function registerModelIpcHandlers(): void {
  ipcMain.handle('models:getProviders', () => modelCatalog.getProviders());
  ipcMain.handle('models:getModels', async (_event, provider: string, refresh = false) =>
    (await modelCatalog.getModels(provider, refresh)).map(modelInfo),
  );
  ipcMain.handle('models:getRecommended', async () => RECOMMENDED_MODELS);
}
