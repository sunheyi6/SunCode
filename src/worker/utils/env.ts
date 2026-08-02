import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '@shared/constants';
import { getProviderEnvKey } from '@shared/provider-env';
import type { AppSettings } from '@shared/types';

/**
 * Environment and configuration utilities.
 * Handles loading/saving settings, API key resolution, and config paths.
 */

const CONFIG_DIR_NAME = '.suncode';
const CONFIG_FILE_NAME = 'config.json';
const MCP_CONFIG_NAME = 'mcp.json';

/**
 * Get the global SunCode config directory.
 */
export function getGlobalConfigDir(): string {
  return join(homedir(), CONFIG_DIR_NAME);
}

/**
 * Get the project-level SunCode config directory.
 */
export function getProjectConfigDir(workingDir: string): string {
  return join(workingDir, CONFIG_DIR_NAME);
}

/**
 * Ensure a config directory exists.
 */
export function ensureConfigDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load settings from disk.
 * Merges global and project-level settings (project overrides global).
 */
export function loadSettings(workingDir: string): AppSettings {
  let settings = { ...DEFAULT_SETTINGS };

  // Load global settings
  const globalDir = getGlobalConfigDir();
  const globalConfigPath = join(globalDir, CONFIG_FILE_NAME);

  if (existsSync(globalConfigPath)) {
    try {
      const global = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
      settings = { ...settings, ...global };
    } catch {
      console.warn('Failed to parse global config, using defaults');
    }
  }

  // Load project settings (override global)
  const projectDir = getProjectConfigDir(workingDir);
  const projectConfigPath = join(projectDir, CONFIG_FILE_NAME);

  if (existsSync(projectConfigPath)) {
    try {
      const project = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
      settings = { ...settings, ...project };
    } catch {
      console.warn('Failed to parse project config, using global settings');
    }
  }

  return { ...settings, permissionMode: 'full_access' };
}

/**
 * Save settings to disk.
 */
export function saveSettings(
  settings: AppSettings,
  workingDir: string,
  scope: 'global' | 'project' = 'global',
): void {
  let configDir: string;

  if (scope === 'project') {
    configDir = getProjectConfigDir(workingDir);
  } else {
    configDir = getGlobalConfigDir();
  }

  ensureConfigDir(configDir);
  const configPath = join(configDir, CONFIG_FILE_NAME);
  writeFileSync(configPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Resolve API key for a provider.
 * Checks environment variables first, then stored settings.
 */
export function resolveApiKey(provider: string, settings: AppSettings): string | undefined {
  // Check settings storage
  if (settings.envApiKeys[provider]) {
    return settings.envApiKeys[provider];
  }

  // Check environment variables (provider-specific)
  const envKey = getProviderEnvKey(provider);
  if (envKey && process.env[envKey]) {
    return process.env[envKey];
  }

  return undefined;
}

/**
 * Load MCP server configurations.
 */
export function loadMcpConfig(workingDir: string): import('@shared/types').McpServerConfig[] {
  const projectDir = getProjectConfigDir(workingDir);
  const projectMcpPath = join(projectDir, MCP_CONFIG_NAME);

  if (existsSync(projectMcpPath)) {
    try {
      return JSON.parse(readFileSync(projectMcpPath, 'utf-8'));
    } catch {
      console.warn('Failed to parse project MCP config');
    }
  }

  const globalMcpPath = join(getGlobalConfigDir(), MCP_CONFIG_NAME);
  if (existsSync(globalMcpPath)) {
    try {
      return JSON.parse(readFileSync(globalMcpPath, 'utf-8'));
    } catch {
      console.warn('Failed to parse global MCP config');
    }
  }

  return [];
}
