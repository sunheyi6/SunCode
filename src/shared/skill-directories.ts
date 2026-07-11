import { join } from 'node:path';

export interface SkillDirectory {
  path: string;
  source: string;
}

/** User-level Agent Skills directories used by popular coding agents. */
export function getVendorSkillDirectories(homeDir: string): SkillDirectory[] {
  const xdgConfigDir = process.env.XDG_CONFIG_HOME || join(homeDir, '.config');

  return [
    { path: join(homeDir, '.codex', 'skills'), source: 'Codex' },
    { path: join(homeDir, '.claude', 'skills'), source: 'Claude Code' },
    { path: join(homeDir, '.gemini', 'skills'), source: 'Gemini CLI' },
    { path: join(homeDir, '.copilot', 'skills'), source: 'GitHub Copilot' },
    { path: join(homeDir, '.agents', 'skills'), source: 'Agent Skills' },
    { path: join(xdgConfigDir, 'opencode', 'skills'), source: 'OpenCode' },
  ];
}
