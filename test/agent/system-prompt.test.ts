import { describe, expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT } from '@shared/constants';
import { buildSystemPrompt, type SystemPromptInput } from '../../src/worker/agent/system-prompt';

function baseInput(overrides?: Partial<SystemPromptInput>): SystemPromptInput {
  return {
    workingDir: '/test/workspace',
    tools: [
      { name: 'read', description: 'Read files', parameters: { type: 'object', properties: {} } },
      { name: 'bash', description: 'Run commands', parameters: { type: 'object', properties: {} } },
      { name: 'write', description: 'Write files', parameters: { type: 'object', properties: {} } },
    ],
    skillsContent: '',
    permissionMode: 'full_access',
    ...overrides,
  };
}

interface StructuredPromptForTest {
  type: string;
  version: number;
  basePrompt: string;
  mode: { permissionMode: string; planModeNotice?: string };
  guidelines: string[];
  tools: Array<{ name: string; description: string; snippet: string }>;
  context: {
    memory?: string;
    relevantLessons?: string;
    projectInstructions?: string;
    planModeInstructions?: string;
    skills?: string;
  };
  environment: { currentDate: string; workingDirectory: string };
}

function parsePrompt(overrides?: Partial<SystemPromptInput>): StructuredPromptForTest {
  return JSON.parse(buildSystemPrompt(baseInput(overrides))) as StructuredPromptForTest;
}

describe('buildSystemPrompt', () => {
  it('returns a structured system prompt envelope', () => {
    const prompt = parsePrompt();

    expect(prompt).toMatchObject({
      type: 'suncode.system_prompt',
      version: 1,
      basePrompt: DEFAULT_SYSTEM_PROMPT,
      mode: { permissionMode: 'full_access' },
      environment: {
        workingDirectory: '/test/workspace',
      },
    });
    expect(prompt.environment.currentDate).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('keeps tool guidance and tool schemas in structured fields', () => {
    const prompt = parsePrompt();

    expect(prompt.guidelines).toContain('Use read to examine files instead of cat or sed.');
    expect(prompt.tools.map((tool) => tool.name)).toEqual(['bash', 'read', 'write']);
    expect(prompt.tools).toContainEqual(
      expect.objectContaining({
        name: 'bash',
        description: 'Run commands',
        snippet: 'Execute a shell command',
      }),
    );
  });

  it('requires concise user-facing progress summaries before tools', () => {
    const prompt = parsePrompt();

    expect(prompt.guidelines).toContain(
      'For user-facing progress between tool calls, output only a concise key-logic summary of at most five lines, then use the concrete tool or command. Do not expose full internal reasoning.',
    );
  });

  it('is deterministic for the same input', () => {
    const input = baseInput({ memoryContent: 'test memory' });
    expect(buildSystemPrompt(input)).toBe(buildSystemPrompt(input));
  });

  it('keeps static fields stable when dynamic context changes', () => {
    const without = parsePrompt({ memoryContent: '', skillsContent: '' });
    const withDynamic = parsePrompt({
      memoryContent: 'Some prior work...',
      skillsContent: '<skill name="test">...</skill>',
    });

    expect({ ...without, context: undefined }).toEqual({
      ...withDynamic,
      context: undefined,
    });
  });

  it('normalizes working directory into the environment field', () => {
    const prompt = parsePrompt({ workingDir: String.raw`D:\project\SunCode` });

    expect(prompt.environment.workingDirectory).toBe('D:/project/SunCode');
  });

  it('omits tools as an empty array when no tools are provided', () => {
    const prompt = parsePrompt({ tools: [] });

    expect(prompt.tools).toEqual([]);
  });

  it('stores permission mode in structured mode fields', () => {
    const planPrompt = parsePrompt({ permissionMode: 'plan' });
    const editPrompt = parsePrompt({ permissionMode: 'auto_edit' });

    expect(planPrompt.mode).toMatchObject({
      permissionMode: 'plan',
      planModeNotice: 'read-only tools only',
    });
    expect(editPrompt.mode).toEqual({ permissionMode: 'auto_edit' });
  });

  it('stores optional context in named fields', () => {
    const prompt = parsePrompt({
      memoryContent: 'Test memory',
      relevantLessonsContent: 'Use the known fix first',
      agentsMdContent: '# Project Rules',
      planModeInstructions: 'Plan first',
      skillsContent: 'SKILL: test',
    });

    expect(prompt.context).toEqual({
      memory: 'Test memory',
      relevantLessons: 'Use the known fix first',
      projectInstructions: '# Project Rules',
      planModeInstructions: 'Plan first',
      skills: 'SKILL: test',
    });
  });

  it('uses custom base prompt without leaking the default prompt', () => {
    const prompt = parsePrompt({ customPrompt: 'CUSTOM PROMPT HERE' });

    expect(prompt.basePrompt).toBe('CUSTOM PROMPT HERE');
    expect(prompt.basePrompt).not.toContain(DEFAULT_SYSTEM_PROMPT);
  });
});
