import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { AppSettings } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/constants';

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

  return settings;
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
 * Map provider names to their standard environment variable names.
 */
function getProviderEnvKey(provider: string): string | undefined {
  const keyMap: Record<string, string | undefined> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GEMINI_API_KEY',
    'google-vertex': 'GOOGLE_CLOUD_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    xai: 'XAI_API_KEY',
    groq: 'GROQ_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    together: 'TOGETHER_API_KEY',
    fireworks: 'FIREWORKS_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
    'cloudflare-ai-gateway': 'CLOUDFLARE_API_KEY',
    'cloudflare-workers-ai': 'CLOUDFLARE_API_KEY',
    'github-copilot': 'COPILOT_GITHUB_TOKEN',
    'kimi-coding': 'KIMI_API_KEY',
    moonshotai: 'MOONSHOT_API_KEY',
    'moonshotai-cn': 'MOONSHOT_API_KEY',
    minimax: 'MINIMAX_API_KEY',
    'minimax-cn': 'MINIMAX_CN_API_KEY',
    huggingface: 'HF_TOKEN',
    xiaomi: 'XIAOMI_API_KEY',
    'xiaomi-token-plan-ams': 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
    'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
    'xiaomi-token-plan-sgp': 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
    opencode: 'OPENCODE_API_KEY',
    'opencode-go': 'OPENCODE_API_KEY',
    'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
    zai: 'ZAI_API_KEY',
    'amazon-bedrock': undefined as string | undefined, // Uses AWS credentials chain
  };

  return keyMap[provider as keyof typeof keyMap] || (undefined as string | undefined);
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
