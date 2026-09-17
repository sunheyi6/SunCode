import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSkillsLoader, preloadSkills } from '../../src/worker/agent/skills';
import { parse } from 'yaml';

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
  it('discovers the self-knowledge skill in source and packaged resources without loading its body', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'suncode-builtin-skills-'));
    temporaryDirectories.push(directory);
    vi.stubEnv('HOME', directory);
    vi.stubEnv('USERPROFILE', directory);
    vi.stubEnv('SUNCODE_SKILLS_DIR', '');
    const sourcePath = join(process.cwd(), 'skills', 'suncode', 'SKILL.md');
    const sourcePrompt = await createSkillsLoader(directory).loadAll();
    expect(sourcePrompt).toContain(sourcePath);
    const body = (await createSkillsLoader(directory).loadSkill(sourcePath))!.content;
    expect(sourcePrompt).not.toContain(body);

    // Copy the declared resources, as packaging does, into an unrelated location.
    const config = parse(await readFile(join(process.cwd(), 'electron-builder.yml'), 'utf8'));
    const resource = config.extraResources.find((entry: { from: string }) => entry.from === 'skills');
    expect(resource).toMatchObject({ from: 'skills', to: 'skills' });
    const packagedDir = join(directory, 'resources', resource.to);
    await cp(join(process.cwd(), resource.from), packagedDir, { recursive: true });
    vi.stubEnv('SUNCODE_SKILLS_DIR', packagedDir);
    const packagedPath = join(packagedDir, 'suncode', 'SKILL.md');
    preloadSkills(directory);
    const packagedPrompt = await createSkillsLoader(directory).loadAll();
    expect(packagedPrompt).toContain(packagedPath);
    expect((await createSkillsLoader(directory).loadSkill(packagedPath))?.content).toBe(body);
    expect(await createSkillsLoader(directory, [], [packagedPath]).loadAll()).not.toContain(packagedPath);
  });

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
