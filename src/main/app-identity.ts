/**
 * Application identity bootstrap — MUST be imported first by the main entry.
 *
 * Why a dedicated module: ES module top-level code runs during import, and
 * several modules (logger.ts, ipc-handlers.ts) resolve `app.getPath('userData')`
 * at their own module top level. `app.getName()` defaults to package.json
 * `name` in dev ("suncode") vs productName in the packaged build ("SunCode").
 * On Windows the single-instance lock key and userData dir are case-insensitive,
 * so dev and the released app would otherwise collide.
 *
 * `app.setName()` must run before the FIRST `app.getPath('userData')` call so
 * the resolved (and cached) userData dir uses the dev-specific name. By putting
 * it here and importing this module before anything else, we guarantee that
 * ordering regardless of where other modules resolve userData.
 */
import { randomUUID } from 'node:crypto';
import type { AppRuntimeIdentity } from '@shared/types';
import { app } from 'electron';

export const IS_DEV = !app.isPackaged;

/**
 * Windows toast / taskbar identity. Dev and packaged builds MUST differ:
 * the same AUMID makes Windows activate the wrong process when both are
 * installed (e.g. toast click launches bare node_modules/electron.exe).
 * Packaged appId stays `com.suncode.app` (electron-builder.yml).
 */
export const APP_USER_MODEL_ID = IS_DEV ? 'com.suncode.app.dev' : 'com.suncode.app';

if (IS_DEV) {
  app.setName('SunCode Dev');
}

// Set as early as possible (module import), before app.ready / first toast.
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

/** Stable for this launch only, so PID reuse and side-by-side dev/prod runs stay distinguishable. */
export const APP_RUNTIME_IDENTITY: AppRuntimeIdentity = Object.freeze({
  appInstanceId: randomUUID(),
  appMode: IS_DEV ? 'development' : 'production',
  appVersion: app.getVersion(),
  mainPid: process.pid,
});

export function getAppRuntimeIdentity(workerThreadId?: number): AppRuntimeIdentity {
  return workerThreadId === undefined
    ? APP_RUNTIME_IDENTITY
    : { ...APP_RUNTIME_IDENTITY, workerThreadId };
}
