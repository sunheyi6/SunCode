import type { SessionMeta } from '@shared/types';
import { appendEvent, findStaleRuns } from './run-store';
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
    if (staleRunIds.length === 0) return;

    console.log(
      `[Recovery] Session "${meta.name}" has ${staleRunIds.length} stale run(s): ${staleRunIds.join(', ')}`,
    );

    // Load the session to repair messages
    const data = await loadSession(meta.id);
    if (!data) return;

    const messages = data.messages;
    let modified = false;

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

    if (modified) {
      await saveSession(meta, messages);
      console.log(`[Recovery] Repaired session "${meta.name}"`);
    }
  } catch (err) {
    console.warn(`[Recovery] Skipping session "${meta.name}" due to error:`, err);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
