import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message, ToolResult } from '@shared/types';
import {
  collectArchiveLinksFromMessages,
  formatEvidenceWindowForPrompt,
  projectToolResultsToEvidence,
  selectPromptEvidenceWindow,
  TurnEvidenceBuffer,
} from '../../src/worker/agent/turn-evidence';
import {
  appendTurnEvidenceEnvelopes,
  loadTurnEvidenceEnvelopes,
} from '../../src/worker/agent/turn-evidence-store';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function bashResult(overrides?: Partial<ToolResult>): ToolResult {
  return {
    toolCallId: 'tc_bash_1',
    name: 'bash',
    success: true,
    output: 'ok\n'.repeat(20),
    details: {
      type: 'command',
      command: 'bun test',
      cwd: 'D:/project',
      exitCode: 0,
      stdout: 'ok\n'.repeat(20),
      stderr: '',
    },
    ...overrides,
  };
}

describe('projectToolResultsToEvidence', () => {
  it('projects bash tool results as source-bearing observations', () => {
    const envelopes = projectToolResultsToEvidence({
      sessionId: 'sess-1',
      runId: 'run-1',
      turnId: 'turn-2',
      toolResults: [bashResult()],
    });

    expect(envelopes).toHaveLength(1);
    const e = envelopes[0]!;
    expect(e).toMatchObject({
      schemaVersion: 1,
      sessionId: 'sess-1',
      runId: 'run-1',
      turnId: 'turn-2',
      kind: 'tool',
      visibility: 'model_visible',
      authority: 'observation',
      source: { toolCallId: 'tc_bash_1' },
    });
    expect(e.evidenceId).toMatch(/^tev_/);
    expect(e.summary).toMatchObject({
      tool: 'bash',
      success: true,
      command: 'bun test',
      exitCode: 0,
    });
    expect(e.integrity?.bodySha256).toHaveLength(64);
  });

  it('records write/edit mutation metadata without body', () => {
    const envelopes = projectToolResultsToEvidence({
      sessionId: 's',
      turnId: 'turn-1',
      toolResults: [
        {
          toolCallId: 'tc_edit',
          name: 'edit',
          success: true,
          output: 'Updated file',
          details: {
            type: 'file_edit',
            filePath: 'src/a.ts',
            status: 'edited',
            addedLines: 3,
            removedLines: 1,
          },
        },
      ],
    });

    expect(envelopes[0]!.summary).toMatchObject({
      tool: 'edit',
      path: 'src/a.ts',
      addedLines: 3,
      removedLines: 1,
    });
  });

  it('attaches artifact ids when provided', () => {
    const envelopes = projectToolResultsToEvidence({
      sessionId: 's',
      turnId: 'turn-1',
      toolResults: [bashResult()],
      artifactIdsByCallId: new Map([['tc_bash_1', 'art_abc']]),
    });
    expect(envelopes[0]!.source.artifactIds).toEqual(['art_abc']);
  });
});

describe('prompt evidence window', () => {
  it('keeps only the most recent N model-visible envelopes', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      projectToolResultsToEvidence({
        sessionId: 's',
        turnId: `turn-${i}`,
        toolResults: [bashResult({ toolCallId: `tc_${i}` })],
      }),
    ).flat();

    const window = selectPromptEvidenceWindow(many, 8);
    expect(window).toHaveLength(8);
    expect(window[0]!.turnId).toBe('turn-4');
    expect(window[7]!.turnId).toBe('turn-11');
  });

  it('formats a compact prompt block', () => {
    const envelopes = projectToolResultsToEvidence({
      sessionId: 's',
      turnId: 'turn-1',
      toolResults: [bashResult()],
    });
    const text = formatEvidenceWindowForPrompt(envelopes);
    expect(text).toContain('Recent turn evidence');
    expect(text).toContain('bash');
    expect(text).toContain('bun test');
  });
});

describe('TurnEvidenceBuffer', () => {
  it('accumulates envelopes across turns', () => {
    const buf = new TurnEvidenceBuffer();
    buf.append(
      projectToolResultsToEvidence({
        sessionId: 's',
        turnId: 'turn-1',
        toolResults: [bashResult()],
      }),
    );
    buf.append(
      projectToolResultsToEvidence({
        sessionId: 's',
        turnId: 'turn-2',
        toolResults: [bashResult({ toolCallId: 'tc2', name: 'read', details: undefined })],
      }),
    );
    expect(buf.all()).toHaveLength(2);
    expect(buf.promptWindow(1)).toHaveLength(1);
    expect(buf.promptWindow(1)[0]!.turnId).toBe('turn-2');
  });

  it('persists to JSONL and seeds on load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tev-store-'));
    tempDirs.push(dir);
    const storePath = join(dir, 'run1.jsonl');

    const buf = new TurnEvidenceBuffer({ storePath });
    buf.append(
      projectToolResultsToEvidence({
        sessionId: 's',
        runId: 'run1',
        turnId: 'turn-1',
        toolResults: [bashResult()],
      }),
    );

    const raw = readFileSync(storePath, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);

    const reloaded = new TurnEvidenceBuffer({ storePath, seedFromStore: true });
    expect(reloaded.all()).toHaveLength(1);
    expect(reloaded.all()[0]!.source.toolCallId).toBe('tc_bash_1');
    expect(reloaded.formatPromptWindow()).toContain('bash');
  });

  it('links archive artifact ids and rewrites durable envelopes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tev-link-'));
    tempDirs.push(dir);
    const storePath = join(dir, 'run2.jsonl');
    const buf = new TurnEvidenceBuffer({ storePath });
    buf.append(
      projectToolResultsToEvidence({
        sessionId: 's',
        turnId: 'turn-1',
        toolResults: [bashResult()],
      }),
    );

    const linked = buf.linkArtifacts(new Map([['tc_bash_1', 'art_deadbeef']]));
    expect(linked).toHaveLength(1);
    expect(buf.all()[0]!.source.artifactIds).toEqual(['art_deadbeef']);

    const loaded = loadTurnEvidenceEnvelopes(storePath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.source.artifactIds).toEqual(['art_deadbeef']);
  });
});

describe('collectArchiveLinksFromMessages', () => {
  it('reads artifact ids from prune placeholders', () => {
    const placeholder = JSON.stringify({
      kind: 'suncode.archived_tool_result',
      schemaVersion: 1,
      toolCallId: 'tc_x',
      toolName: 'bash',
      artifactId: 'tc_x_abc',
      bodySha256: 'a'.repeat(64),
      bodyHash: 'a'.repeat(16),
      originalTokens: 5000,
      originalBytes: 20000,
      originalChars: 20000,
      reason: 'active_current_turn_tool_result_pruned_before_next_step',
      rewriteVersion: 1,
    });
    const msgs: Message[] = [{ role: 'tool', content: placeholder, toolCallId: 'tc_x' }];
    const links = collectArchiveLinksFromMessages(msgs);
    expect(links.get('tc_x')).toBe('tc_x_abc');
  });
});

describe('turn-evidence-store append/load', () => {
  it('last-write-wins on evidenceId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tev-lww-'));
    tempDirs.push(dir);
    const path = join(dir, 'x.jsonl');
    const first = projectToolResultsToEvidence({
      sessionId: 's',
      turnId: 'turn-1',
      toolResults: [bashResult()],
      ts: 1,
    })[0]!;
    const second = {
      ...first,
      source: { ...first.source, artifactIds: ['linked'] },
    };
    appendTurnEvidenceEnvelopes(path, [first, second]);
    const loaded = loadTurnEvidenceEnvelopes(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.source.artifactIds).toEqual(['linked']);
  });
});
