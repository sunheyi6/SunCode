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

if (IS_DEV) {
  app.setName('SunCode Dev');
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
