import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DayStats, ModelStats, RunEvent, RunId } from '@shared/types';

/** Base directory for run event logs. */
function runsDir(sessionId: string): string {
  return join(process.cwd(), '.suncode', 'sessions', sessionId, 'runs');
}

function runFilePath(sessionId: string, runId: RunId): string {
  return join(runsDir(sessionId), `${runId}.jsonl`);
}

/** Aggregated token usage file. Updated incrementally as runs complete. */
function usageAggregatePath(): string {
  return join(process.cwd(), '.suncode', 'token-usage.json');
}

interface UsageAggregate {
  daily: Record<string, DayStats>;
  byModel: Record<string, ModelStats>;
  totals: { input: number; output: number; total: number; runs: number };
}

/** In-memory cache of the model name for each active run (run_started -> run_completed). */
const runModelNames = new Map<string, string>();

function getRunKey(sessionId: string, runId: RunId): string {
  return `${sessionId}::${runId}`;
}

async function readUsageAggregate(): Promise<UsageAggregate> {
  try {
    const raw = await readFile(usageAggregatePath(), 'utf-8');
    return JSON.parse(raw) as UsageAggregate;
  } catch {
    return { daily: {}, byModel: {}, totals: { input: 0, output: 0, total: 0, runs: 0 } };
  }
}

async function writeUsageAggregate(aggregate: UsageAggregate): Promise<void> {
  await writeFile(usageAggregatePath(), JSON.stringify(aggregate, null, 2), 'utf-8');
}

async function incrementUsageAggregate(
  sessionId: string,
  runId: RunId,
  event: Extract<RunEvent, { type: 'run_completed' }>,
): Promise<void> {
  const date = event.timestamp.split('T')[0] ?? 'unknown';
  const modelName = runModelNames.get(getRunKey(sessionId, runId)) ?? 'unknown';

  const aggregate = await readUsageAggregate();

  const usage = event.tokenUsage ?? { input: 0, output: 0, total: 0 };

  // Daily aggregation
  const day = aggregate.daily[date] ?? {
    date,
    input: 0,
    output: 0,
    total: 0,
    runs: 0,
  };
  day.input += usage.input;
  day.output += usage.output;
  day.total += usage.total;
  day.runs += 1;
  aggregate.daily[date] = day;

  // Per-model aggregation
  const model = aggregate.byModel[modelName] ?? {
    modelName,
    input: 0,
    output: 0,
    total: 0,
    runs: 0,
  };
  model.input += usage.input;
  model.output += usage.output;
  model.total += usage.total;
  model.runs += 1;
  aggregate.byModel[modelName] = model;

  // Totals
  aggregate.totals.input += usage.input;
  aggregate.totals.output += usage.output;
  aggregate.totals.total += usage.total;
  aggregate.totals.runs += 1;

  await writeUsageAggregate(aggregate);
}

/** Return the current usage aggregate (daily sorted by date ascending). */
export async function getTokenUsageAggregate(): Promise<{
  daily: DayStats[];
  byModel: ModelStats[];
  totals: { input: number; output: number; total: number; runs: number };
}> {
  const aggregate = await readUsageAggregate();
  const daily = Object.values(aggregate.daily).sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const byModel = Object.values(aggregate.byModel).sort((a, b) => b.total - a.total);
  return { daily, byModel, totals: aggregate.totals };
}

/** Create the run directory (the first appendEvent call writes the initial event). */
export async function startRun(sessionId: string, runId: RunId): Promise<void> {
  const dir = runsDir(sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Don't write a bare run_started here — the worker's appendEvent call
  // immediately follows with the full event including modelName and tokenUsage.
}

/** Append a single RunEvent to the JSONL file and update usage aggregate when a run finishes. */
export async function appendEvent(sessionId: string, runId: RunId, event: RunEvent): Promise<void> {
  event.timestamp = new Date().toISOString();
  await appendFile(runFilePath(sessionId, runId), `${JSON.stringify(event)}\n`, 'utf-8');

  if (event.type === 'run_started' && event.modelName) {
    runModelNames.set(getRunKey(sessionId, runId), event.modelName);
  }

  if (event.type === 'run_completed') {
    await incrementUsageAggregate(sessionId, runId, event);
  }
}

/** Append the final event to close a run. */
export async function endRun(sessionId: string, runId: RunId, finalEvent: RunEvent): Promise<void> {
  await appendEvent(sessionId, runId, finalEvent);
}

/** List all run IDs for a session. */
export async function listRuns(sessionId: string): Promise<RunId[]> {
  const dir = runsDir(sessionId);
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith('.jsonl')).map((f) => f.replace('.jsonl', ''));
  } catch {
    return [];
  }
}

/** Read all events from a run's JSONL file. */
export async function getEvents(sessionId: string, runId: RunId): Promise<RunEvent[]> {
  try {
    const raw = await readFile(runFilePath(sessionId, runId), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    return lines.map((line) => {
      try {
        return JSON.parse(line) as RunEvent;
      } catch {
        // Corrupt line — return a marker event
        return {
          type: 'run_recovered',
          runId,
          reason: 'corrupt_event_line',
          timestamp: new Date().toISOString(),
        } as RunEvent;
      }
    });
  } catch {
    return [];
  }
}

/** Find run IDs that don't have a terminal event (completed, failed, aborted, recovered). */
export async function findStaleRuns(sessionId: string): Promise<RunId[]> {
  const allRuns = await listRuns(sessionId);
  const stale: RunId[] = [];

  for (const runId of allRuns) {
    const events = await getEvents(sessionId, runId);
    if (events.length === 0) continue;

    const lastEvent = events[events.length - 1];
    const terminalTypes = new Set(['run_completed', 'run_failed', 'run_aborted', 'run_recovered']);

    if (!terminalTypes.has(lastEvent.type)) {
      stale.push(runId);
    }
  }

  return stale;
}
