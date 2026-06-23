import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEvent, RunId } from '@shared/types';

/** Base directory for run event logs. */
function runsDir(sessionId: string): string {
  return join(process.cwd(), '.suncode', 'sessions', sessionId, 'runs');
}

function runFilePath(sessionId: string, runId: RunId): string {
  return join(runsDir(sessionId), `${runId}.jsonl`);
}

/** Create the run directory and write the initial event. */
export async function startRun(sessionId: string, runId: RunId): Promise<void> {
  const dir = runsDir(sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const event: RunEvent = {
    type: 'run_started',
    runId,
    timestamp: new Date().toISOString(),
  };
  await appendFile(runFilePath(sessionId, runId), `${JSON.stringify(event)}\n`, 'utf-8');
}

/** Append a single RunEvent to the JSONL file. */
export async function appendEvent(sessionId: string, runId: RunId, event: RunEvent): Promise<void> {
  event.timestamp = new Date().toISOString();
  await appendFile(runFilePath(sessionId, runId), `${JSON.stringify(event)}\n`, 'utf-8');
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
