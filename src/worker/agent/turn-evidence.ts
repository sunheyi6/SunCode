/**
 * Turn Evidence — source-bearing bounded projections of tool observations.
 *
 * Derived from tool results (and later artifacts/checks). Not a second truth
 * ledger: summaries must name their source and may be rebuilt from canonical
 * facts + raw archives.
 *
 * Phase B: kind=tool only, authority=observation, visibility=model_visible.
 * Phase C: prompt window + completion-gate consumers + archive source links.
 */

import { createHash } from 'node:crypto';
import { TURN_EVIDENCE_PREVIEW_CHARS, TURN_EVIDENCE_PROMPT_WINDOW } from '@shared/constants';
import type {
  ArchivedToolResultPlaceholder,
  Message,
  ToolResult,
  TurnEvidenceEnvelope,
  TurnEvidenceIntegrity,
  TurnEvidenceToolSummary,
} from '@shared/types';
import { hashToolResultBody } from './tool-result-archive';
import {
  appendTurnEvidenceEnvelopes,
  linkArtifactIdsToEvidence,
  loadTurnEvidenceEnvelopes,
} from './turn-evidence-store';

export interface ProjectToolEvidenceInput {
  sessionId: string;
  runId?: string;
  turnId: string;
  toolResults: ToolResult[];
  /** Optional full model-facing body for integrity (e.g. formatToolResultForModel). */
  modelBodiesByCallId?: Map<string, string>;
  /** Optional archive artifact ids keyed by toolCallId. */
  artifactIdsByCallId?: Map<string, string>;
  ts?: number;
}

export function projectToolResultsToEvidence(
  input: ProjectToolEvidenceInput,
): TurnEvidenceEnvelope[] {
  const ts = input.ts ?? Date.now();
  const envelopes: TurnEvidenceEnvelope[] = [];

  for (const result of input.toolResults) {
    const modelBody = input.modelBodiesByCallId?.get(result.toolCallId);
    const summary = buildToolSummary(result);
    const integrity = buildIntegrity(result, modelBody);
    const artifactId = input.artifactIdsByCallId?.get(result.toolCallId);

    const evidenceId = makeEvidenceId({
      turnId: input.turnId,
      toolCallId: result.toolCallId,
      toolName: result.name,
      ts,
    });

    envelopes.push({
      schemaVersion: 1,
      evidenceId,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts,
      kind: 'tool',
      source: {
        toolCallId: result.toolCallId,
        ...(artifactId ? { artifactIds: [artifactId] } : {}),
      },
      visibility: 'model_visible',
      authority: 'observation',
      summary,
      integrity,
    });
  }

  return envelopes;
}

/**
 * Bounded prompt projection: newest-first window of model-visible observations.
 * Does not include restricted/internal envelopes.
 */
export function selectPromptEvidenceWindow(
  envelopes: TurnEvidenceEnvelope[],
  limit = TURN_EVIDENCE_PROMPT_WINDOW,
): TurnEvidenceEnvelope[] {
  const visible = envelopes.filter(
    (e) => e.visibility === 'model_visible' && e.authority !== 'authoritative',
  );
  if (visible.length <= limit) return visible;
  return visible.slice(visible.length - limit);
}

/** Compact text block for optional system/context injection (phase C consumer). */
export function formatEvidenceWindowForPrompt(envelopes: TurnEvidenceEnvelope[]): string {
  const window = selectPromptEvidenceWindow(envelopes);
  if (window.length === 0) return '';

  const lines = window.map((e, i) => {
    const s = e.summary as TurnEvidenceToolSummary;
    const tool = 'tool' in s ? s.tool : e.kind;
    const ok = 'success' in s ? (s.success ? 'ok' : 'fail') : '?';
    const src = e.source.toolCallId ? ` call=${e.source.toolCallId.slice(0, 12)}` : '';
    const detail = summarizeForLine(s);
    return `${i + 1}. [${e.turnId}] ${tool} ${ok}${src}${detail ? ` — ${detail}` : ''}`;
  });

  return [
    '## Recent turn evidence (source-bearing observations, not official proof)',
    ...lines,
  ].join('\n');
}

function buildToolSummary(result: ToolResult): TurnEvidenceToolSummary {
  const name = result.name;
  const errorPreview = preview(result.error);

  if (name === 'bash' || result.details?.type === 'command') {
    const details = result.details?.type === 'command' ? result.details : undefined;
    return {
      tool: 'bash',
      success: result.success,
      command: details?.command,
      cwd: details?.cwd,
      exitCode: details?.exitCode,
      stdoutPreview: preview(details?.stdout ?? result.output),
      stderrPreview: preview(details?.stderr),
      errorPreview,
    };
  }

  if (name === 'read' || name === 'grep' || name === 'glob') {
    return {
      tool: name,
      success: result.success,
      path: extractPathFromOutput(result),
      query: extractQueryFromOutput(result),
      observationPreview: preview(result.output),
      errorPreview,
    };
  }

  if (name === 'write' || name === 'edit' || result.details?.type === 'file_edit') {
    const details = result.details?.type === 'file_edit' ? result.details : undefined;
    return {
      tool: name === 'write' ? 'write' : 'edit',
      success: result.success,
      path: details?.filePath,
      editStatus: details?.status,
      addedLines: details?.addedLines,
      removedLines: details?.removedLines,
      errorPreview,
    };
  }

  return {
    tool: name as Exclude<string, 'bash' | 'read' | 'grep' | 'glob' | 'write' | 'edit'>,
    success: result.success,
    outputPreview: preview(result.output),
    errorPreview,
  };
}

function buildIntegrity(
  result: ToolResult,
  modelBody: string | undefined,
): TurnEvidenceIntegrity | undefined {
  const body = modelBody ?? result.output ?? '';
  if (!body && !result.error) return undefined;

  const originalBytes = Buffer.byteLength(body, 'utf8');
  const truncated =
    Boolean(result.details?.type === 'command' && result.details.fullOutputPath) ||
    body.includes('earlier lines skipped') ||
    body.includes('Full output saved to:');

  const integrity: TurnEvidenceIntegrity = {
    bodySha256: body ? hashToolResultBody(body) : undefined,
    originalBytes: body ? originalBytes : undefined,
    visibleBytes: body ? originalBytes : undefined,
    truncated: truncated || undefined,
  };

  if (result.details?.type === 'command' && result.details.fullOutputPath) {
    // Visible body is a tail window; full payload lives at fullOutputPath.
    integrity.truncated = true;
  }

  return integrity;
}

function makeEvidenceId(parts: {
  turnId: string;
  toolCallId: string;
  toolName: string;
  ts: number;
}): string {
  const raw = `${parts.turnId}|${parts.toolCallId}|${parts.toolName}|${parts.ts}`;
  return `tev_${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

function preview(text: string | undefined, max = TURN_EVIDENCE_PREVIEW_CHARS): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function summarizeForLine(summary: TurnEvidenceToolSummary): string {
  if (isBashSummary(summary)) {
    const cmd = summary.command ? truncate(summary.command, 80) : '';
    const code =
      summary.exitCode === undefined || summary.exitCode === null
        ? ''
        : ` exit=${summary.exitCode}`;
    return `${cmd}${code}`.trim();
  }
  if (isPathQuerySummary(summary)) {
    return [summary.path, summary.query].filter(Boolean).join(' ').slice(0, 100);
  }
  if (isMutationSummary(summary)) {
    return summary.path ?? '';
  }
  return summary.outputPreview?.slice(0, 80) ?? summary.errorPreview?.slice(0, 80) ?? '';
}

function isBashSummary(
  s: TurnEvidenceToolSummary,
): s is Extract<TurnEvidenceToolSummary, { tool: 'bash' }> {
  return s.tool === 'bash';
}

function isPathQuerySummary(
  s: TurnEvidenceToolSummary,
): s is Extract<TurnEvidenceToolSummary, { tool: 'read' | 'grep' | 'glob' }> {
  return s.tool === 'read' || s.tool === 'grep' || s.tool === 'glob';
}

function isMutationSummary(
  s: TurnEvidenceToolSummary,
): s is Extract<TurnEvidenceToolSummary, { tool: 'write' | 'edit' }> {
  return s.tool === 'write' || s.tool === 'edit';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function extractPathFromOutput(result: ToolResult): string | undefined {
  if (result.details?.type === 'file_edit') return result.details.filePath;
  const m = /(?:path|file)["\s:=]+([^\s"']+)/i.exec(result.output);
  return m?.[1];
}

function extractQueryFromOutput(result: ToolResult): string | undefined {
  const m = /(?:pattern|query)["\s:=]+([^\n"']+)/i.exec(result.output);
  return m?.[1]?.slice(0, 80);
}

/**
 * Collect toolCallId → artifactId from archived placeholders in provider messages.
 */
export function collectArchiveLinksFromMessages(messages: readonly Message[]): Map<string, string> {
  const links = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    const placeholder = parseArchivedPlaceholder(msg.content);
    if (!placeholder?.artifactId || !placeholder.toolCallId) continue;
    links.set(placeholder.toolCallId, placeholder.artifactId);
  }
  return links;
}

export function parseArchivedPlaceholder(
  content: string,
): ArchivedToolResultPlaceholder | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<ArchivedToolResultPlaceholder>;
    if (parsed?.kind !== 'suncode.archived_tool_result') return undefined;
    if (typeof parsed.toolCallId !== 'string' || typeof parsed.artifactId !== 'string') {
      return undefined;
    }
    return parsed as ArchivedToolResultPlaceholder;
  } catch {
    return undefined;
  }
}

/** In-memory + optional JSONL-backed evidence buffer for one agent run. */
export class TurnEvidenceBuffer {
  private envelopes: TurnEvidenceEnvelope[] = [];
  private storePath?: string;

  constructor(options?: { storePath?: string; seedFromStore?: boolean }) {
    this.storePath = options?.storePath;
    if (options?.seedFromStore && this.storePath) {
      this.envelopes = loadTurnEvidenceEnvelopes(this.storePath);
    }
  }

  get path(): string | undefined {
    return this.storePath;
  }

  append(batch: TurnEvidenceEnvelope[]): void {
    if (batch.length === 0) return;
    this.envelopes.push(...batch);
    if (this.storePath) {
      appendTurnEvidenceEnvelopes(this.storePath, batch);
    }
  }

  /**
   * After active/stale prune, attach archive artifact ids to matching envelopes
   * and persist the updated envelopes (last-write-wins on load).
   */
  linkArtifacts(links: ReadonlyMap<string, string>): TurnEvidenceEnvelope[] {
    const updated = linkArtifactIdsToEvidence(this.envelopes, links);
    if (updated.length === 0) return [];

    const byId = new Map(updated.map((e) => [e.evidenceId, e]));
    this.envelopes = this.envelopes.map((e) => byId.get(e.evidenceId) ?? e);
    if (this.storePath) {
      appendTurnEvidenceEnvelopes(this.storePath, updated);
    }
    return updated;
  }

  all(): readonly TurnEvidenceEnvelope[] {
    return this.envelopes;
  }

  clear(): void {
    this.envelopes = [];
  }

  promptWindow(limit?: number): TurnEvidenceEnvelope[] {
    return selectPromptEvidenceWindow(this.envelopes, limit);
  }

  /** Text block for system-prompt injection (empty when no model-visible evidence). */
  formatPromptWindow(limit?: number): string {
    return formatEvidenceWindowForPrompt(
      limit === undefined ? this.envelopes : selectPromptEvidenceWindow(this.envelopes, limit),
    );
  }
}
