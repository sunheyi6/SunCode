import type { RuntimeEvent } from '@shared/runtime-events';
import type { Message, RunEvent, SessionMeta } from '@shared/types';
import { appendEvent, findStaleRuns, getEvents, listRuns } from './run-store';
import {
  appendRuntimeEvent,
  clearRuntimePartial,
  initializeRuntimeLedger,
  readRuntimeEvents,
  readRuntimePartial,
} from './runtime-event-store';
import {
  findOpenInvocationIds,
  invocationHasAssistantMessage,
  projectionCursorMatches,
  projectSessionRuntime,
  wasInvocationStopRequested,
} from './runtime-projector';
import { loadAllSessions, loadSession, saveSession } from './session-store';

const STARTUP_RECOVERY_SESSION_LIMIT = 5;
const BACKGROUND_RECOVERY_BATCH_SIZE = 8;
const BACKGROUND_RECOVERY_INITIAL_DELAY_MS = 5_000;
const BACKGROUND_RECOVERY_BATCH_DELAY_MS = 2_000;

const INTERRUPTED_PLACEHOLDER =
  '[Interrupted — the application was closed before the model could respond.]';
const INTERRUPTED_PARTIAL_SUFFIX =
  '\n\n[Interrupted before the response reached a terminal state.]';

interface RecoveryOptions {
  initialLimit?: number;
  backgroundBatchSize?: number;
  backgroundInitialDelayMs?: number;
  backgroundBatchDelayMs?: number;
  scheduleBackground?: boolean;
}

/**
 * Scan all sessions for interrupted (non-terminal) runs and repair them.
 * Called once at startup. Recent sessions are repaired immediately; older
 * sessions are throttled in the background so startup never walks the full
 * run history at once. Conservative — only appends recovery markers, never
 * deletes or re-executes.
 */
export async function recoverInterruptedSessions(options: RecoveryOptions = {}): Promise<void> {
  const sessions = await loadAllSessions();
  const initialLimit = options.initialLimit ?? STARTUP_RECOVERY_SESSION_LIMIT;
  const immediateSessions = sessions.slice(0, initialLimit);
  const deferredSessions = sessions.slice(initialLimit);

  if (sessions.length === 0) return;

  console.log(
    `[Recovery] Checking ${immediateSessions.length} recent session(s); deferring ${deferredSessions.length} older session(s).`,
  );

  await recoverSessionBatch(immediateSessions);

  if (deferredSessions.length === 0 || options.scheduleBackground === false) return;

  const backgroundBatchSize = options.backgroundBatchSize ?? BACKGROUND_RECOVERY_BATCH_SIZE;
  const backgroundInitialDelayMs =
    options.backgroundInitialDelayMs ?? BACKGROUND_RECOVERY_INITIAL_DELAY_MS;
  const backgroundBatchDelayMs =
    options.backgroundBatchDelayMs ?? BACKGROUND_RECOVERY_BATCH_DELAY_MS;

  setTimeout(() => {
    void recoverDeferredSessions(
      deferredSessions,
      backgroundBatchSize,
      backgroundBatchDelayMs,
    ).catch((err: unknown) => {
      console.warn('[Recovery] Background recovery failed:', err);
    });
  }, backgroundInitialDelayMs);
}

async function recoverDeferredSessions(
  sessions: SessionMeta[],
  batchSize: number,
  batchDelayMs: number,
): Promise<void> {
  console.log(`[Recovery] Background recovery started for ${sessions.length} older session(s).`);

  for (let index = 0; index < sessions.length; index += batchSize) {
    const batch = sessions.slice(index, index + batchSize);
    await recoverSessionBatch(batch);

    if (index + batchSize < sessions.length) {
      await delay(batchDelayMs);
    }
  }

  console.log('[Recovery] Background recovery finished.');
}

async function recoverSessionBatch(sessions: SessionMeta[]): Promise<void> {
  for (const meta of sessions) {
    await recoverSession(meta);
  }
}

async function recoverSession(meta: SessionMeta): Promise<void> {
  try {
    const operationalStaleRunIds = await findStaleRuns(meta.id);
    let runtimeEvents = await readRuntimeEvents(meta.id);
    let openRuntimeRunIds = findOpenInvocationIds(runtimeEvents);

    const mayNeedCompletedRecovery = await sessionTailNeedsCompletedRecovery(
      meta.id,
      runtimeEvents,
    );
    const cursorStale =
      runtimeEvents.length > 0 &&
      !projectionCursorMatches(meta.runtimeProjection, projectSessionRuntime(runtimeEvents).cursor);

    // Healthy sessions: no operational stale runs, no open semantic invocations,
    // no orphaned user tail, and projection cursor already matches the ledger.
    if (
      operationalStaleRunIds.length === 0 &&
      openRuntimeRunIds.length === 0 &&
      !mayNeedCompletedRecovery &&
      !cursorStale
    ) {
      return;
    }

    // Empty ledger may still need a one-time import from session.json.
    if (runtimeEvents.length === 0) {
      const data = await loadSession(meta.id);
      if (!data) return;
      runtimeEvents = await initializeRuntimeLedger(meta.id, data.messages);
      openRuntimeRunIds = findOpenInvocationIds(runtimeEvents);
    }

    const completedRuntimeRunIds = await findOperationallyCompletedRuns(meta.id, openRuntimeRunIds);
    const openToInterrupt = openRuntimeRunIds.filter((runId) => !completedRuntimeRunIds.has(runId));
    const openToComplete = openRuntimeRunIds.filter((runId) => completedRuntimeRunIds.has(runId));
    const legacyOperationalStale = operationalStaleRunIds.filter(
      (runId) => !openRuntimeRunIds.includes(runId),
    );
    const interruptRunIds = [...new Set([...openToInterrupt, ...legacyOperationalStale])];
    const operationalStaleRunIdSet = new Set(operationalStaleRunIds);

    let modified = cursorStale;

    if (interruptRunIds.length > 0 || openToComplete.length > 0) {
      console.log(
        `[Recovery] Session "${meta.name}" has ${interruptRunIds.length} interrupted and ${openToComplete.length} completed-open run(s)`,
      );
    }

    for (const runId of interruptRunIds) {
      if (operationalStaleRunIdSet.has(runId)) {
        await appendEvent(meta.id, runId, {
          type: 'run_recovered',
          runId,
          reason: 'app_restarted',
          timestamp: new Date().toISOString(),
        });
      }

      const stopRequested = wasInvocationStopRequested(runtimeEvents, runId);
      const needsAssistant =
        !invocationHasAssistantMessage(runtimeEvents, runId) &&
        (invocationHasUserMessage(runtimeEvents, runId) ||
          projectSessionRuntime(runtimeEvents).messages.at(-1)?.role === 'user');

      if (needsAssistant) {
        const interruptedMessage = await buildRecoveryAssistantMessage(meta.id, runId);
        if (interruptedMessage) {
          await appendRuntimeEvent(meta.id, {
            eventId: `${runId}:recovery-assistant`,
            runId,
            turnId: `recovery-${runId}`,
            invocationId: runId,
            fact: { type: 'assistant_message_committed', message: interruptedMessage },
          });
        }
      }

      await appendRuntimeEvent(meta.id, {
        eventId: `${runId}:terminal`,
        runId,
        turnId: `recovery-${runId}`,
        invocationId: runId,
        fact: {
          type: 'invocation_terminated',
          status: stopRequested ? 'aborted' : 'interrupted',
          reason: stopRequested ? 'user_stop_before_restart' : 'app_restarted',
        },
      });
      await clearRuntimePartial(meta.id, runId);
      runtimeEvents = await readRuntimeEvents(meta.id);
      modified = true;
    }

    for (const runId of openToComplete) {
      if (!invocationHasAssistantMessage(runtimeEvents, runId)) {
        const recovered = await findCompletedAssistantMessageForRun(meta.id, runId);
        if (recovered) {
          const finalMessageEventId = `${runId}:recovered-final-assistant`;
          await appendRuntimeEvent(meta.id, {
            eventId: finalMessageEventId,
            runId,
            turnId: `recovery-${runId}`,
            invocationId: runId,
            fact: { type: 'assistant_message_committed', message: recovered },
          });
          await appendRuntimeEvent(meta.id, {
            eventId: `${runId}:terminal`,
            runId,
            turnId: `recovery-${runId}`,
            invocationId: runId,
            fact: {
              type: 'invocation_terminated',
              status: 'completed',
              finalMessageEventId,
            },
          });
          runtimeEvents = await readRuntimeEvents(meta.id);
          modified = true;
          continue;
        }
      }

      await appendRuntimeEvent(meta.id, {
        eventId: `${runId}:terminal`,
        runId,
        turnId: `recovery-${runId}`,
        invocationId: runId,
        fact: { type: 'invocation_terminated', status: 'completed' },
      });
      await clearRuntimePartial(meta.id, runId);
      runtimeEvents = await readRuntimeEvents(meta.id);
      modified = true;
    }

    // Legacy renderer-crash path: operational run completed but never entered the
    // semantic ledger as an open invocation (pre-migration sessions).
    runtimeEvents = await readRuntimeEvents(meta.id);
    let projection = projectSessionRuntime(runtimeEvents);
    if (projection.messages.at(-1)?.role === 'user') {
      const recovered = await findLatestCompletedAssistantMessage(meta.id);
      if (recovered && !invocationHasAssistantMessage(runtimeEvents, recovered.runId)) {
        const finalMessageEventId = `${recovered.runId}:recovered-final-assistant`;
        await appendRuntimeEvent(meta.id, {
          eventId: finalMessageEventId,
          runId: recovered.runId,
          turnId: `recovery-${recovered.runId}`,
          invocationId: recovered.runId,
          fact: { type: 'assistant_message_committed', message: recovered.message },
        });
        await appendRuntimeEvent(meta.id, {
          eventId: `${recovered.runId}:terminal`,
          runId: recovered.runId,
          turnId: `recovery-${recovered.runId}`,
          invocationId: recovered.runId,
          fact: {
            type: 'invocation_terminated',
            status: 'completed',
            finalMessageEventId,
          },
        });
        modified = true;
        console.log(`[Recovery] Rebuilt completed assistant message for "${meta.name}"`);
      }
    }

    if (modified || cursorStale) {
      projection = projectSessionRuntime(await readRuntimeEvents(meta.id));
      if (
        !projectionCursorMatches(meta.runtimeProjection, projection.cursor) ||
        meta.messageCount !== projection.messages.length
      ) {
        meta.runtimeProjection = projection.cursor;
        meta.messageCount = projection.messages.length;
        meta.updated = new Date().toISOString();
        await saveSession(meta, projection.messages);
        console.log(`[Recovery] Repaired session "${meta.name}"`);
      }
    }
  } catch (err) {
    console.warn(`[Recovery] Skipping session "${meta.name}" due to error:`, err);
  }
}

async function sessionTailNeedsCompletedRecovery(
  sessionId: string,
  runtimeEvents: RuntimeEvent[],
): Promise<boolean> {
  if (runtimeEvents.length > 0) {
    return projectSessionRuntime(runtimeEvents).messages.at(-1)?.role === 'user';
  }
  const tail = await loadSession(sessionId, 1);
  return tail?.messages.at(-1)?.role === 'user';
}

function invocationHasUserMessage(events: RuntimeEvent[], runId: string): boolean {
  return events.some(
    (event) => event.invocationId === runId && event.fact.type === 'user_message_committed',
  );
}

async function buildRecoveryAssistantMessage(
  sessionId: string,
  runId: string,
): Promise<Message | null> {
  const runtimePartial = await readRuntimePartial(sessionId, runId);
  const partialMessage = runtimePartial
    ? buildInterruptedAssistantMessageFromData(runtimePartial.data)
    : buildInterruptedAssistantMessage(await getEvents(sessionId, runId));
  return (
    partialMessage ?? {
      role: 'assistant',
      content: [{ type: 'text', text: INTERRUPTED_PLACEHOLDER }],
    }
  );
}

function buildInterruptedAssistantMessage(events: RunEvent[]): Message | null {
  let text = '';
  let thinking = '';
  for (const event of events) {
    if (event.type !== 'content.part') continue;
    if (event.part.kind === 'text') text += event.part.text;
    else thinking += event.part.thinking;
  }
  if (!text && !thinking) return null;

  const content: Message['content'] = [];
  if (thinking) content.push({ type: 'thinking', text: thinking });
  if (text) content.push({ type: 'text', text });
  content.push({ type: 'text', text: INTERRUPTED_PARTIAL_SUFFIX });
  return { role: 'assistant', content };
}

function buildInterruptedAssistantMessageFromData(data: {
  text: string;
  thinking: string;
}): Message | null {
  if (!data.text && !data.thinking) return null;
  const content: Message['content'] = [];
  if (data.thinking) content.push({ type: 'thinking', text: data.thinking });
  if (data.text) content.push({ type: 'text', text: data.text });
  content.push({ type: 'text', text: INTERRUPTED_PARTIAL_SUFFIX });
  return { role: 'assistant', content };
}

async function findOperationallyCompletedRuns(
  sessionId: string,
  runIds: string[],
): Promise<Set<string>> {
  const completed = new Set<string>();
  for (const runId of runIds) {
    const events = await getEvents(sessionId, runId);
    if (events.some((event) => event.type === 'run_completed')) completed.add(runId);
  }
  return completed;
}

async function findCompletedAssistantMessageForRun(
  sessionId: string,
  runId: string,
): Promise<Message | null> {
  const events = await getEvents(sessionId, runId);
  const completed = events.some((event) => event.type === 'run_completed');
  if (!completed) return null;

  const finalRequest = [...events]
    .reverse()
    .find(
      (event): event is Extract<RunEvent, { type: 'model_request_completed' }> =>
        event.type === 'model_request_completed' && Boolean(event.responseText?.trim()),
    );
  if (!finalRequest?.responseText) return null;

  const text = extractRecoveredText(finalRequest.responseText);
  if (!text) return null;

  const content: Message['content'] = [];
  if (finalRequest.responseThinking) {
    content.push({ type: 'thinking', text: finalRequest.responseThinking });
  }
  content.push({ type: 'text', text });
  return { role: 'assistant', content };
}

async function findLatestCompletedAssistantMessage(
  sessionId: string,
): Promise<{ runId: string; message: Message } | null> {
  const candidates: Array<{ timestamp: string; runId: string; message: Message }> = [];

  for (const runId of await listRuns(sessionId)) {
    const events = await getEvents(sessionId, runId);
    const completed = [...events]
      .reverse()
      .find(
        (event): event is Extract<RunEvent, { type: 'run_completed' }> =>
          event.type === 'run_completed',
      );
    if (!completed) continue;

    const finalRequest = [...events]
      .reverse()
      .find(
        (event): event is Extract<RunEvent, { type: 'model_request_completed' }> =>
          event.type === 'model_request_completed' && Boolean(event.responseText?.trim()),
      );
    if (!finalRequest?.responseText) continue;

    const text = extractRecoveredText(finalRequest.responseText);
    if (!text) continue;

    const content: Message['content'] = [];
    if (finalRequest.responseThinking) {
      content.push({ type: 'thinking', text: finalRequest.responseThinking });
    }
    content.push({ type: 'text', text });
    candidates.push({
      timestamp: completed.timestamp,
      runId,
      message: { role: 'assistant', content },
    });
  }

  candidates.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const latest = candidates[candidates.length - 1];
  return latest ? { runId: latest.runId, message: latest.message } : null;
}

function extractRecoveredText(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const extracted = textFromStructuredValue(parsed);
    if (extracted) return extracted;
  } catch {
    // The response may already be plain text.
  }
  return trimmed;
}

function textFromStructuredValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        isRecord(item) && item.type === 'text' ? textFromStructuredValue(item.text) : '',
      )
      .filter(Boolean)
      .join('')
      .trim();
  }
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text.trim();
  return textFromStructuredValue(value.content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
