import type { AppRuntimeIdentity } from './types';

const ENV_KEYS = {
  appInstanceId: 'SUNCODE_APP_INSTANCE_ID',
  appMode: 'SUNCODE_APP_MODE',
  appVersion: 'SUNCODE_APP_VERSION',
  mainPid: 'SUNCODE_MAIN_PID',
} as const;

type RuntimeEnvironment = Record<string, string | undefined>;

export function runtimeIdentityEnvironment(identity: AppRuntimeIdentity): Record<string, string> {
  return {
    [ENV_KEYS.appInstanceId]: identity.appInstanceId,
    [ENV_KEYS.appMode]: identity.appMode,
    [ENV_KEYS.appVersion]: identity.appVersion,
    [ENV_KEYS.mainPid]: String(identity.mainPid),
  };
}

export function readRuntimeIdentityEnvironment(
  env: RuntimeEnvironment,
  workerThreadId?: number,
): AppRuntimeIdentity | undefined {
  const appInstanceId = env[ENV_KEYS.appInstanceId];
  const appMode = env[ENV_KEYS.appMode];
  const appVersion = env[ENV_KEYS.appVersion];
  const mainPid = Number(env[ENV_KEYS.mainPid]);

  if (
    !appInstanceId ||
    (appMode !== 'development' && appMode !== 'production') ||
    !appVersion ||
    !Number.isInteger(mainPid) ||
    mainPid <= 0
  ) {
    return undefined;
  }

  return {
    appInstanceId,
    appMode,
    appVersion,
    mainPid,
    workerThreadId,
  };
}
