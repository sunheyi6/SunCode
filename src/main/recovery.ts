import type { Message, RunEvent, SessionMeta } from '@shared/types';
import { appendEvent, findStaleRuns, getEvents, listRuns } from './run-store';
import { loadAllSessions, loadSession, saveSession } from './session-store';

const STARTUP_RECOVERY_SESSION_LIMIT = 5;
const BACKGROUND_RECOVERY_BATCH_SIZE = 8;
const BACKGROUND_RECOVERY_INITIAL_DELAY_MS = 5_000;
const BACKGROUND_RECOVERY_BATCH_DELAY_MS = 2_000;

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
    const staleRunIds = await findStaleRuns(meta.id);
    const tail = await loadSession(meta.id, 1);
    if (!tail) return;

    const mayNeedCompletedRecovery = tail.messages[tail.messages.length - 1]?.role === 'user';
    if (staleRunIds.length === 0 && !mayNeedCompletedRecovery) return;

    // Stale-run repair needs the complete history; completed-run repair only
    // needs it when the tail confirms that the latest user message is orphaned.
    const data =
      staleRunIds.length > 0 || mayNeedCompletedRecovery ? await loadSession(meta.id) : tail;
    if (!data) return;

    const messages = data.messages;
    let modified = false;

    if (staleRunIds.length > 0) {
      console.log(
        `[Recovery] Session "${meta.name}" has ${staleRunIds.length} stale run(s): ${staleRunIds.join(', ')}`,
      );
    }

    for (const runId of staleRunIds) {
      // Append recovery marker to the JSONL event log
      await appendEvent(meta.id, runId, {
        type: 'run_recovered',
        runId,
        reason: 'app_restarted',
        timestamp: new Date().toISOString(),
      });

      // Check if the last message is a user message without a matching
      // assistant response — the run was interrupted before the model replied.
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === 'user') {
          // Append a synthetic assistant message marking the interruption
          messages.push({
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: '[Interrupted — the application was closed before the model could respond.]',
              },
            ],
          });
          meta.messageCount = messages.length;
          meta.updated = new Date().toISOString();
          modified = true;
        }
      }
    }

    // A renderer crash can happen after the worker has emitted run_completed.
    // Such a run is not stale, but its final assistant message may still be
    // absent because the old persistence path lived in the renderer. Rebuild
    // that message from the last completed model request when possible.
    if (messages[messages.length - 1]?.role === 'user') {
      const recovered = await findLatestCompletedAssistantMessage(meta.id);
      if (recovered) {
        messages.push(recovered);
        meta.messageCount = messages.length;
        meta.updated = new Date().toISOString();
        modified = true;
        console.log(`[Recovery] Rebuilt completed assistant message for "${meta.name}"`);
      }
    }

    if (modified) {
      await saveSession(meta, messages);
      console.log(`[Recovery] Repaired session "${meta.name}"`);
    }
  } catch (err) {
    console.warn(`[Recovery] Skipping session "${meta.name}" due to error:`, err);
  }
}

async function findLatestCompletedAssistantMessage(sessionId: string): Promise<Message | null> {
  const candidates: Array<{ timestamp: string; message: Message }> = [];

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
    candidates.push({ timestamp: completed.timestamp, message: { role: 'assistant', content } });
  }

  candidates.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return candidates[candidates.length - 1]?.message ?? null;
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
