import { BUILTIN_COMMANDS, createSkillCommands, matchCommands } from '@shared/commands';
import { describe, expect, it } from 'vitest';

describe('createSkillCommands', () => {
  it('creates slash-command candidates for enabled skills only', () => {
    const commands = createSkillCommands(
      [
        {
          name: 'Grill Me',
          description: 'Review a plan rigorously',
          path: 'C:/skills/grill-me/SKILL.md',
          source: 'Codex',
        },
        {
          name: 'Disabled Skill',
          description: 'Should not be offered',
          path: 'C:/skills/disabled/SKILL.md',
          source: 'Codex',
        },
      ],
      ['C:/skills/disabled/SKILL.md'],
    );

    expect(commands).toEqual([
      expect.objectContaining({
        name: 'grill-me',
        label: 'Grill Me',
        handler: 'text',
      }),
    ]);
    expect(matchCommands('/grill', [...BUILTIN_COMMANDS, ...commands])[0]?.command.name).toBe('grill-me');
  });
});
