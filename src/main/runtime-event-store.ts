import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RUNTIME_EVENT_PROTOCOL_VERSION,
  type RuntimeEvent,
  type RuntimeEventDraft,
  type RuntimeTerminationStatus,
} from '@shared/runtime-events';
import type { Message, StreamMessageData } from '@shared/types';
import { getAppDataDir } from './paths';

export class RuntimeInvocationClosedError extends Error {
  readonly code = 'RUNTIME_INVOCATION_CLOSED' as const;

  constructor(
    readonly invocationId: string,
    readonly existingStatus?: RuntimeTerminationStatus,
  ) {
    super(
      existingStatus
        ? `Invocation ${invocationId} already terminated as ${existingStatus}`
        : `Invocation ${invocationId} is already closed`,
    );
    this.name = 'RuntimeInvocationClosedError';
  }
}

export function isRuntimeInvocationClosedError(
  error: unknown,
): error is RuntimeInvocationClosedError {
  return error instanceof RuntimeInvocationClosedError;
}

interface LedgerState {
  events: RuntimeEvent[];
  eventsById: Map<string, RuntimeEvent>;
  terminalByInvocation: Map<string, RuntimeEvent>;
}

const ledgerQueues = new Map<string, Promise<void>>();
const ledgerStates = new Map<string, LedgerState>();
const partialTimers = new Map<string, ReturnType<typeof setTimeout>>();
const partialSnapshots = new Map<string, RuntimePartialSnapshot>();
const partialWriteQueues = new Map<string, Promise<void>>();

export interface RuntimePartialSnapshot {
  sessionId: string;
  runId: string;
  turnId: string;
  updatedAt: string;
  data: StreamMessageData;
}

function sessionRuntimeDir(sessionId: string): string {
  return join(getAppDataDir(), 'sessions', sessionId);
}

export function runtimeEventLogPath(sessionId: string): string {
  return join(sessionRuntimeDir(sessionId), 'runtime-events.jsonl');
}

function runtimePartialsDir(sessionId: string): string {
  return join(sessionRuntimeDir(sessionId), 'runtime-partials');
}

function runtimePartialPath(sessionId: string, runId: string): string {
  return join(runtimePartialsDir(sessionId), `${runId}.json`);
}

function partialKey(sessionId: string, runId: string): string {
  return `${sessionId}::${runId}`;
}

function enqueuePartialWrite(snapshot: RuntimePartialSnapshot): Promise<void> {
  const key = partialKey(snapshot.sessionId, snapshot.runId);
  const previous = partialWriteQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const dir = runtimePartialsDir(snapshot.sessionId);
      await mkdir(dir, { recursive: true });
      const path = runtimePartialPath(snapshot.sessionId, snapshot.runId);
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot), 'utf-8');
      await rename(temporary, path);
    });
  partialWriteQueues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Keep at most one replaceable stream snapshot per active invocation. */
export function scheduleRuntimePartial(snapshot: RuntimePartialSnapshot): void {
  const key = partialKey(snapshot.sessionId, snapshot.runId);
  partialSnapshots.set(key, snapshot);
  const timer = partialTimers.get(key);
  if (timer) clearTimeout(timer);
  partialTimers.set(
    key,
    setTimeout(() => {
      partialTimers.delete(key);
      const latest = partialSnapshots.get(key);
      if (!latest) return;
      void enqueuePartialWrite(latest).catch((error: unknown) => {
        console.warn('[RuntimeEvent] Failed to persist partial snapshot:', error);
      });
    }, 250),
  );
}

export async function flushRuntimePartial(sessionId: string, runId: string): Promise<void> {
  const key = partialKey(sessionId, runId);
  const timer = partialTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    partialTimers.delete(key);
  }
  const snapshot = partialSnapshots.get(key);
  if (snapshot) await enqueuePartialWrite(snapshot);
  await partialWriteQueues.get(key);
}

export async function readRuntimePartial(
  sessionId: string,
  runId: string,
): Promise<RuntimePartialSnapshot | null> {
  try {
    const raw = await readFile(runtimePartialPath(sessionId, runId), 'utf-8');
    return JSON.parse(raw) as RuntimePartialSnapshot;
  } catch {
    return null;
  }
}

export async function clearRuntimePartial(sessionId: string, runId: string): Promise<void> {
  const key = partialKey(sessionId, runId);
  const timer = partialTimers.get(key);
  if (timer) clearTimeout(timer);
  partialTimers.delete(key);
  partialSnapshots.delete(key);
  await partialWriteQueues.get(key);
  partialWriteQueues.delete(key);
  try {
    await unlink(runtimePartialPath(sessionId, runId));
  } catch {
    // Missing partial snapshots are already clear.
  }
}

async function enqueueLedgerTask<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = ledgerQueues.get(sessionId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(task);
  ledgerQueues.set(
    sessionId,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

async function loadLedgerState(sessionId: string): Promise<LedgerState> {
  const cached = ledgerStates.get(sessionId);
  if (cached) return cached;

  const events = await readRuntimeEventsFromDisk(sessionId);
  validateRuntimeEvents(sessionId, events);
  const state: LedgerState = {
    events,
    eventsById: new Map(events.map((event) => [event.eventId, event])),
    terminalByInvocation: new Map(),
  };
  for (const event of events) {
    if (event.fact.type === 'invocation_terminated' && event.invocationId) {
      state.terminalByInvocation.set(event.invocationId, event);
    }
  }
  ledgerStates.set(sessionId, state);
  return state;
}

async function readRuntimeEventsFromDisk(sessionId: string): Promise<RuntimeEvent[]> {
  const path = runtimeEventLogPath(sessionId);
  if (!existsSync(path)) return [];

  const raw = await readFile(path, 'utf-8');
  const events: RuntimeEvent[] = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as RuntimeEvent);
    } catch {
      throw new Error(`Corrupt Runtime Event Log line ${index + 1} for session ${sessionId}`);
    }
  }
  return events;
}

function validateRuntimeEvents(sessionId: string, events: RuntimeEvent[]): void {
  let previousEventId: string | undefined;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const expectedSequence = index + 1;
    if (event.sessionId !== sessionId) {
      throw new Error(`Runtime event ${event.eventId} belongs to another session`);
    }
    if (event.sequence !== expectedSequence || event.previousEventId !== previousEventId) {
      throw new Error(`Broken Runtime Event Log order at sequence ${expectedSequence}`);
    }
    previousEventId = event.eventId;
  }
}

async function writeDurableEvent(sessionId: string, event: RuntimeEvent): Promise<void> {
  const dir = sessionRuntimeDir(sessionId);
  await mkdir(dir, { recursive: true });
  const file = await open(runtimeEventLogPath(sessionId), 'a');
  try {
    await file.writeFile(`${JSON.stringify(event)}\n`, 'utf-8');
    await file.sync();
  } finally {
    await file.close();
  }
}

function factsEqual(left: RuntimeEventDraft['fact'], right: RuntimeEventDraft['fact']): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function appendToState(
  sessionId: string,
  state: LedgerState,
  draft: RuntimeEventDraft,
): Promise<RuntimeEvent> {
  const eventId = draft.eventId ?? randomUUID();
  const duplicate = state.eventsById.get(eventId);
  if (duplicate) {
    const sameIdentity =
      duplicate.runId === draft.runId &&
      duplicate.turnId === draft.turnId &&
      duplicate.invocationId === draft.invocationId;
    if (!sameIdentity || !factsEqual(duplicate.fact, draft.fact)) {
      throw new Error(`Runtime event ID collision for ${eventId}`);
    }
    return duplicate;
  }

  if (draft.fact.type === 'invocation_terminated' && draft.invocationId) {
    const terminal = state.terminalByInvocation.get(draft.invocationId);
    if (terminal) {
      if (terminal.fact.type !== 'invocation_terminated') return terminal;
      if (terminal.fact.status !== draft.fact.status) {
        throw new RuntimeInvocationClosedError(draft.invocationId, terminal.fact.status);
      }
      return terminal;
    }
  }

  if (draft.invocationId && state.terminalByInvocation.has(draft.invocationId)) {
    const terminal = state.terminalByInvocation.get(draft.invocationId);
    const status =
      terminal?.fact.type === 'invocation_terminated' ? terminal.fact.status : undefined;
    throw new RuntimeInvocationClosedError(draft.invocationId, status);
  }

  const previous = state.events.at(-1);
  const event: RuntimeEvent = {
    protocolVersion: RUNTIME_EVENT_PROTOCOL_VERSION,
    eventId,
    sequence: (previous?.sequence ?? 0) + 1,
    timestamp: draft.timestamp ?? new Date().toISOString(),
    previousEventId: previous?.eventId,
    sessionId,
    turnId: draft.turnId,
    runId: draft.runId,
    invocationId: draft.invocationId,
    partial: false,
    fact: draft.fact,
  };

  await writeDurableEvent(sessionId, event);
  state.events.push(event);
  state.eventsById.set(event.eventId, event);
  if (event.fact.type === 'invocation_terminated' && event.invocationId) {
    state.terminalByInvocation.set(event.invocationId, event);
  }
  return event;
}

/**
 * Append one immutable semantic fact. Existing session snapshots are imported
 * exactly once so old sessions remain replayable during migration.
 */
export async function appendRuntimeEvent(
  sessionId: string,
  draft: RuntimeEventDraft,
  legacyMessages: Message[] = [],
): Promise<RuntimeEvent> {
  return enqueueLedgerTask(sessionId, async () => {
    const state = await loadLedgerState(sessionId);
    if (state.events.length === 0 && legacyMessages.length > 0) {
      await appendToState(sessionId, state, {
        eventId: `${sessionId}:legacy-snapshot`,
        fact: { type: 'legacy_snapshot_imported', messages: legacyMessages },
      });
    }
    return appendToState(sessionId, state, draft);
  });
}

export async function initializeRuntimeLedger(
  sessionId: string,
  legacyMessages: Message[],
): Promise<RuntimeEvent[]> {
  return enqueueLedgerTask(sessionId, async () => {
    const state = await loadLedgerState(sessionId);
    if (state.events.length === 0 && legacyMessages.length > 0) {
      await appendToState(sessionId, state, {
        eventId: `${sessionId}:legacy-snapshot`,
        fact: { type: 'legacy_snapshot_imported', messages: legacyMessages },
      });
    }
    return [...state.events];
  });
}

export async function readRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
  return enqueueLedgerTask(sessionId, async () => {
    const state = await loadLedgerState(sessionId);
    return [...state.events];
  });
}

export function invalidateRuntimeEventCache(sessionId: string): void {
  ledgerStates.delete(sessionId);
}
