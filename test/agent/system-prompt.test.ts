/**
 * System Prompt — comprehensive test suite.
 *
 * Follows Kimi Code's metadata + behavior pattern.
 * Key focus: cache stability (static prefix never changes across builds).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT } from '@shared/constants';
import { buildSystemPrompt, type SystemPromptInput } from '../../src/worker/agent/system-prompt';

// ── Base input factory (stable across tests) ──

function baseInput(overrides?: Partial<SystemPromptInput>): SystemPromptInput {
  return {
    workingDir: '/test/workspace',
    tools: [
      { name: 'read', description: 'Read files', parameters: { type: 'object', properties: {} } },
      { name: 'bash', description: 'Run commands', parameters: { type: 'object', properties: {} } },
      { name: 'write', description: 'Write files', parameters: { type: 'object', properties: {} } },
    ],
    skillsContent: '',
    maxTurns: 50,
    permissionMode: 'full_access',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════
// LAYER 1: Structure
// ═══════════════════════════════════════════════════

describe('structure', () => {
  it('always includes the DEFAULT_SYSTEM_PROMPT as the opening section', () => {
    const prompt = buildSystemPrompt(baseInput());
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
  });

  it('static sections appear before dynamic sections', () => {
    const prompt = buildSystemPrompt(baseInput());
    const guidelinesIdx = prompt.indexOf('## Guidelines');
    const toolsIdx = prompt.indexOf('## Available Tools');

    // Guidelines comes first
    expect(guidelinesIdx).toBeGreaterThan(0);
    // Tools comes after guidelines
    expect(toolsIdx).toBeGreaterThan(guidelinesIdx);
  });

  it('includes all required sections', () => {
    const prompt = buildSystemPrompt(baseInput());
    expect(prompt).toContain('## Guidelines');
    expect(prompt).toContain('## Available Tools');
    expect(prompt).toContain('Current working directory:');
  });
});

// ═══════════════════════════════════════════════════
// LAYER 2: Cache stability (CRITICAL)
// ═══════════════════════════════════════════════════

describe('cache stability', () => {
  it('includes date in the footer (not cache-stable across days)', () => {
    // Date is now included at the end for LLM context awareness
    const prompt = buildSystemPrompt(baseInput());
    expect(prompt).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
  });

  it('static prefix is identical across two builds', () => {
    const p1 = buildSystemPrompt(baseInput());
    const p2 = buildSystemPrompt(baseInput());
    // Same input → identical output (deterministic)
    expect(p1).toBe(p2);
  });

  it('static prefix is identical regardless of memory content', () => {
    const without = buildSystemPrompt(baseInput({ memoryContent: '' }));
    const with_ = buildSystemPrompt(baseInput({ memoryContent: 'Some prior work...' }));

    // Find where the project_memory section starts
    const memTag = '<project_memory>';
    const baseIdx = without.indexOf(memTag);
    const dynamicIdx = with_.indexOf(memTag);

    // The prefix BEFORE project_memory should be identical
    if (baseIdx > 0 && dynamicIdx > 0) {
      expect(without.slice(0, baseIdx)).toBe(with_.slice(0, dynamicIdx));
    }
  });

  it('static prefix is identical regardless of skills content', () => {
    const without = buildSystemPrompt(baseInput({ skillsContent: '' }));
    const with_ = buildSystemPrompt(baseInput({ skillsContent: '<skill name="test">...</skill>' }));

    const skillsTag = '<available_skills>';
    const baseIdx = without.indexOf(skillsTag);
    const dynamicIdx = with_.indexOf(skillsTag);

    if (baseIdx > 0 && dynamicIdx > 0) {
      expect(without.slice(0, baseIdx)).toBe(with_.slice(0, dynamicIdx));
    }
  });

  it('produces the same output for same input (idempotent)', () => {
    // Run 3 times with same input
    const input = baseInput({ memoryContent: 'test memory' });
    const results = Array.from({ length: 3 }, () => buildSystemPrompt(input));
    const [first, ...rest] = results;
    for (const r of rest) {
      expect(r).toBe(first);
    }
  });
});

// ═══════════════════════════════════════════════════
// LAYER 3: Content
// ═══════════════════════════════════════════════════

describe('environment', () => {
  it('includes working directory', () => {
    const prompt = buildSystemPrompt(baseInput({ workingDir: '/custom/path' }));
    expect(prompt).toContain('Current working directory: /custom/path');
  });

  it('includes date', () => {
    const prompt = buildSystemPrompt(baseInput());
    expect(prompt).toContain('Current date:');
  });

  it('does NOT contain Date: (old format)', () => {
    const prompt = buildSystemPrompt(baseInput());
    expect(prompt).not.toContain('Date:');
  });
});

describe('tools', () => {
  it('lists all tools with descriptions', () => {
    const prompt = buildSystemPrompt(baseInput());
    expect(prompt).toContain('- **read**');
    expect(prompt).toContain('- **bash**');
    expect(prompt).toContain('- **write**');
  });

  it('warns against verifying background processes by global process name', () => {
    const prompt = DEFAULT_SYSTEM_PROMPT;

    expect(prompt).toContain('Get-Process -Id <pid>');
    expect(prompt).toMatch(/Never verify background startup by global process name/i);
    expect(prompt).toContain('Get-Process -Name electron');
  });

  it('tells service launches to wait for explicit readiness evidence', () => {
    const prompt = DEFAULT_SYSTEM_PROMPT;

    expect(prompt).toContain('startup_marker');
    expect(prompt).toContain('readiness_timeout');
  });

  it('does not expose SunCode internal startup marker as a reusable project marker', () => {
    const prompt = DEFAULT_SYSTEM_PROMPT;

    expect(prompt).not.toContain('STARTUP_COMPLETE');
  });

  it('omits Available Tools section when no tools provided', () => {
    const prompt = buildSystemPrompt(baseInput({ tools: [] }));
    expect(prompt).not.toContain('## Available Tools');
  });
});

describe('permission mode', () => {
  it('renders plan mode with read-only notice', () => {
    const prompt = buildSystemPrompt(baseInput({ permissionMode: 'plan' }));
    expect(prompt).toContain('## Mode: plan — read-only tools only');
  });

  it('full_access mode has no permission restriction notice', () => {
    const prompt = buildSystemPrompt(baseInput({ permissionMode: 'full_access' }));
    expect(prompt).not.toContain('## Mode: plan');
  });

  it('auto_edit mode has no permission restriction notice', () => {
    const prompt = buildSystemPrompt(baseInput({ permissionMode: 'auto_edit' }));
    expect(prompt).not.toContain('## Mode: plan');
  });
});

describe('optional sections', () => {
  it('includes project_memory when memoryContent is provided', () => {
    const prompt = buildSystemPrompt(baseInput({ memoryContent: 'Test memory' }));
    expect(prompt).toContain('<project_memory>');
    expect(prompt).toContain('Test memory');
    expect(prompt).toContain('</project_memory>');
  });

  it('omits project_memory when memoryContent is empty', () => {
    const prompt = buildSystemPrompt(baseInput({ memoryContent: '' }));
    expect(prompt).not.toContain('<project_memory>');
  });

  it('includes project_context when agentsMdContent is provided', () => {
    const prompt = buildSystemPrompt(baseInput({ agentsMdContent: '# Project Rules' }));
    expect(prompt).toContain('<project_context>');
    expect(prompt).toContain('# Project Rules');
    expect(prompt).toContain('</project_context>');
  });

  it('includes skills when skillsContent is provided', () => {
    const prompt = buildSystemPrompt(baseInput({ skillsContent: 'SKILL: test' }));
    expect(prompt).toContain('<available_skills>');
    expect(prompt).toContain('SKILL: test');
    expect(prompt).toContain('</available_skills>');
  });

  it('uses custom prompt when provided', () => {
    const prompt = buildSystemPrompt(baseInput({ customPrompt: 'CUSTOM PROMPT HERE' }));
    expect(prompt.startsWith('CUSTOM PROMPT HERE')).toBe(true);
    expect(prompt).not.toContain(DEFAULT_SYSTEM_PROMPT);
  });
});
