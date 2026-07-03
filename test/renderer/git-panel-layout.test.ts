import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const gitPanelSource = readFileSync('src/renderer/components/layout/GitPanel.vue', 'utf8');

function scopedStyleBlock(source: string): string {
  const match = source.match(/<style scoped>([\s\S]*?)<\/style>/);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

function cssRule(style: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = style.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

describe('GitPanel layout', () => {
  test('keeps the floating shell non-blocking while controls remain clickable', () => {
    const style = scopedStyleBlock(gitPanelSource);
    const floatRule = cssRule(style, '.git-float');
    const interactiveRule = cssRule(style, '.git-float button,\n.git-float .git-card');
    const pillRule = cssRule(style, '.git-pill');

    expect(floatRule).toMatch(/position\s*:\s*absolute/);
    expect(floatRule).toMatch(/top\s*:\s*clamp\(88px,\s*12vh,\s*128px\)/);
    expect(floatRule).toMatch(/pointer-events\s*:\s*none/);
    expect(interactiveRule).toMatch(/pointer-events\s*:\s*auto/);
    expect(pillRule).toMatch(/opacity\s*:\s*0\.42/);
  });

  test('shows the active plan summary before git stats while collapsed', () => {
    const planTemplateIndex = gitPanelSource.indexOf('<template v-if="hasPlan">');
    const taskTemplateIndex = gitPanelSource.indexOf('<template v-else-if="currentRunningProcess">');
    const gitTemplateIndex = gitPanelSource.indexOf('<template v-else-if="gitStatus.isRepo">');

    expect(planTemplateIndex).toBeGreaterThan(-1);
    expect(taskTemplateIndex).toBeGreaterThan(-1);
    expect(gitTemplateIndex).toBeGreaterThan(-1);
    expect(planTemplateIndex).toBeLessThan(taskTemplateIndex);
    expect(planTemplateIndex).toBeLessThan(gitTemplateIndex);
    expect(taskTemplateIndex).toBeLessThan(gitTemplateIndex);
    expect(gitPanelSource).toContain('currentRunningProcess.value');
    expect(gitPanelSource).toContain('currentPlanStep?.description');
    expect(gitPanelSource).toContain('currentRunningProcess.command');
  });
});
