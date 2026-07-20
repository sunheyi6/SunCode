/**
 * Durable TurnEvidence store — JSONL under session data dir.
 *
 * Lines are full envelopes (append-only). Later lines with the same evidenceId
 * replace earlier ones (last-write-wins) so artifact links can be recorded
 * without mutating history in place.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TurnEvidenceEnvelope } from '@shared/types';
import { getAgentDataSubdir } from './agent-data-dir';

export interface TurnEvidenceStorePathArgs {
  workingDir: string;
  sessionId: string;
  runId: string;
}

export function resolveTurnEvidencePath(args: TurnEvidenceStorePathArgs): string {
  const dir = getAgentDataSubdir(args.workingDir, '.suncode/turn-evidence', args.sessionId);
  const safeRun = args.runId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return join(dir, `${safeRun}.jsonl`);
}

/** Append envelopes (one JSON object per line). Best-effort; never throws to callers. */
export function appendTurnEvidenceEnvelopes(
  filePath: string,
  envelopes: readonly TurnEvidenceEnvelope[],
): { written: number; error?: string } {
  if (envelopes.length === 0) return { written: 0 };
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const body = `${envelopes.map((e) => JSON.stringify(e)).join('\n')}\n`;
    appendFileSync(filePath, body, 'utf8');
    return { written: envelopes.length };
  } catch (error) {
    const message = (error as Error).message;
    console.warn(`[TurnEvidenceStore] append failed: ${message}`);
    return { written: 0, error: message };
  }
}

/**
 * Load envelopes with last-write-wins per evidenceId (document order preserved
 * for first-seen ids; replacements update content in place).
 */
export function loadTurnEvidenceEnvelopes(filePath: string): TurnEvidenceEnvelope[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf8');
    const byId = new Map<string, TurnEvidenceEnvelope>();
    const order: string[] = [];

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isTurnEvidenceEnvelope(parsed)) continue;
      if (!byId.has(parsed.evidenceId)) {
        order.push(parsed.evidenceId);
      }
      byId.set(parsed.evidenceId, parsed);
    }

    return order.map((id) => byId.get(id)!).filter(Boolean);
  } catch (error) {
    console.warn(`[TurnEvidenceStore] load failed: ${(error as Error).message}`);
    return [];
  }
}

export function isTurnEvidenceEnvelope(value: unknown): value is TurnEvidenceEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === 1 &&
    typeof v.evidenceId === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.turnId === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.visibility === 'string' &&
    typeof v.authority === 'string' &&
    typeof v.source === 'object' &&
    v.source !== null
  );
}

/** Attach artifactId to envelopes matching toolCallId; returns updated copies. */
export function linkArtifactIdsToEvidence(
  envelopes: readonly TurnEvidenceEnvelope[],
  links: ReadonlyMap<string, string>,
): TurnEvidenceEnvelope[] {
  if (links.size === 0) return [];
  const updated: TurnEvidenceEnvelope[] = [];
  for (const env of envelopes) {
    const toolCallId = env.source.toolCallId;
    if (!toolCallId) continue;
    const artifactId = links.get(toolCallId);
    if (!artifactId) continue;
    const existing = env.source.artifactIds ?? [];
    if (existing.includes(artifactId)) continue;
    updated.push({
      ...env,
      source: {
        ...env.source,
        artifactIds: [...existing, artifactId],
      },
    });
  }
  return updated;
}
