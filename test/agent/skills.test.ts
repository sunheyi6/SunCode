import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSkillsLoader, preloadSkills } from '../../src/worker/agent/skills';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createSkill(directory: string, name: string): Promise<void> {
  const skillDir = join(directory, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\ndescription: ${name} description\n---\n# ${name}`);
}

describe('createSkillsLoader', () => {
  it('loads skills from supported coding-agent user directories', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'suncode-skills-'));
    temporaryDirectories.push(homeDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);

    const directories = [
      ['.codex', 'skills'],
      ['.claude', 'skills'],
      ['.gemini', 'skills'],
      ['.copilot', 'skills'],
      ['.agents', 'skills'],
      ['.config', 'opencode', 'skills'],
    ];
    await Promise.all(
      directories.map((directory, index) => createSkill(join(homeDir, ...directory), `vendor-${index}`)),
    );

    preloadSkills(homeDir);
    const prompt = await createSkillsLoader(homeDir).loadAll();

    for (const [index, directory] of directories.entries()) {
      expect(prompt).toContain(
        `**vendor-${index}** (command: \`/vendor-${index}\`): vendor-${index} description`,
      );
      expect(prompt).toContain(join(homeDir, ...directory, `vendor-${index}`, 'SKILL.md'));
    }

    const disabledPath = join(homeDir, '.codex', 'skills', 'vendor-0', 'SKILL.md');
    const promptWithDisabledSkill = await createSkillsLoader(homeDir, [], [disabledPath]).loadAll();
    expect(promptWithDisabledSkill).not.toContain('**vendor-0** (command: `/vendor-0`)');
  });
});
