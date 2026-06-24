import { loadAllSessions, loadSession, saveSession } from './session-store';
import { findStaleRuns, appendEvent } from './run-store';

/**
 * Scan all sessions for interrupted (non-terminal) runs and repair them.
 * Called once at startup. Conservative — only appends recovery markers,
 * never deletes or re-executes.
 */
export async function recoverInterruptedSessions(): Promise<void> {
  const sessions = await loadAllSessions();
  console.log(`[Recovery] Scanning ${sessions.length} sessions for interrupted runs...`);

  for (const meta of sessions) {
    try {
      const staleRunIds = await findStaleRuns(meta.id);
      if (staleRunIds.length === 0) continue;

      console.log(
        `[Recovery] Session "${meta.name}" has ${staleRunIds.length} stale run(s): ${staleRunIds.join(', ')}`,
      );

      // Load the session to repair messages
      const data = await loadSession(meta.id);
      if (!data) continue;

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
              content: '[Interrupted — the application was closed before the model could respond.]',
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
}
