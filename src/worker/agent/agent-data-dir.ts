import { join } from 'node:path';

export function getAgentDataDir(workingDir: string, sessionId?: string): string {
  const appDataDir = process.env.SUNCODE_APP_DATA;
  if (appDataDir && sessionId) {
    return join(appDataDir, 'sessions', sessionId);
  }
  return workingDir;
}

export function getAgentDataSubdir(
  workingDir: string,
  legacySubdir: string,
  sessionId?: string,
): string {
  const appDataDir = process.env.SUNCODE_APP_DATA;
  if (appDataDir && sessionId) {
    return join(
      getAgentDataDir(workingDir, sessionId),
      legacySubdir.replace(/^\.suncode[\\/]/, ''),
    );
  }
  return join(workingDir, legacySubdir);
}
