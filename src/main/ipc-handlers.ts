import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, watch as fsWatch, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_SETTINGS,
  LITE_MODELS,
  MAX_SESSION_TITLE_LENGTH,
  TITLE_GENERATION_PROMPT,
} from '@shared/constants';
import { validateImageAttachments } from '@shared/image-attachments';
import { getProviderEnvKey } from '@shared/provider-env';
import type { RuntimeEventDraft, RuntimeTerminationStatus } from '@shared/runtime-events';
import { runtimeIdentityEnvironment } from '@shared/runtime-identity';
import { getVendorSkillDirectories } from '@shared/skill-directories';
import type {
  AppRuntimeIdentity,
  AppSettings,
  DayStats,
  DiscoveredSkill,
  FileNode,
  ImageAttachment,
  Message,
  ModelStats,
  RunEvent,
  SessionMeta,
  TokenUsageSummary,
  UiLanguage,
  WorkerInMessage,
  WorkerOutMessage,
} from '@shared/types';
import { app, dialog, ipcMain, Notification, nativeTheme, shell } from 'electron';
import { APP_RUNTIME_IDENTITY, getAppRuntimeIdentity, IS_DEV } from './app-identity';
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateStatus,
  installUpdate,
  skipVersion,
} from './auto-updater';
import { checkoutGitBranch, getGitInfo, listGitBranches } from './git-info';
import {
  createWorktreeForSession,
  isGitRepo,
  isInsideWorktree,
  removeWorktreeForSession,
  validateWorktreePath,
} from './git-worktree';
import { registerModelIpcHandlers } from './ipc/model-handlers';
import { registerSettingsIpcHandlers } from './ipc/settings-handlers';
import { getLogPath, logger } from './logger';
import { getAppDataDir } from './paths';
import { appendEvent, getEvents, getTokenUsageAggregate, listRuns, startRun } from './run-store';
import {
  appendRuntimeEvent,
  clearRuntimePartial,
  initializeRuntimeLedger,
  invalidateRuntimeEventCache,
  isRuntimeInvocationClosedError,
  readRuntimeEvents,
  scheduleRuntimePartial,
} from './runtime-event-store';
import { createSessionRuntimeProjector, projectionCursorMatches } from './runtime-projector';
import {
  deleteSession,
  deleteSessions,
  getSessionFilePath,
  initSessionStore,
  limitMessages,
  loadAllSessions,
  loadSession,
  saveSession,
} from './session-store';
import { applyWindowChrome, setCustomWindowChrome } from './window-chrome';
import type { WindowManager } from './window-manager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ===== Settings Persistence — 保存在标准用户数据目录 =====
const CONFIG_DIR = getAppDataDir();
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

function loadSettings(): AppSettings {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const saved = JSON.parse(raw) as Partial<AppSettings>;
      // Migrate the old 200-turn default. Goal mode has its own explicit budget;
      // ordinary tasks should not inherit an effectively unbounded legacy value.
      if (saved.maxTurns === 200) saved.maxTurns = DEFAULT_SETTINGS.maxTurns;
      return { ...DEFAULT_SETTINGS, ...saved, permissionMode: 'full_access' };
    }
  } catch (e) {
    console.warn('[Main] Failed to load settings:', (e as Error).message);
  }
  return { ...DEFAULT_SETTINGS };
}

async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true });
    }
    await writeFile(CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    console.log('[Main] Settings saved to', CONFIG_PATH);
  } catch (e) {
    console.error('[Main] Failed to save settings:', (e as Error).message);
  }
}

const watchers = new Map<string, () => void>();
let agentWorker: Worker | null = null;
let currentSettings: AppSettings = loadSettings();

// ===== 启动时同步 Key 到环境变量（关键！pi-ai 从 process.env 读取） =====
for (const [provider, key] of Object.entries(currentSettings.envApiKeys)) {
  const envKey = getProviderEnvKey(provider);
  if (envKey && key) {
    process.env[envKey] = key;
    console.log(`[Main] ENV ${envKey} set from config`);
  }
}

// Pass dev mode flag to worker for conditional logging
process.env.SUNCODE_IS_DEV = IS_DEV ? '1' : '0';
const sessions: Map<string, SessionMeta> = new Map();
const sessionMessages: Map<string, Message[]> = new Map();
const runtimeProjectors = new Map<string, ReturnType<typeof createSessionRuntimeProjector>>();
let currentSessionId: string | null = null;
/** The session that originated the current agent prompt (may differ from
 *  currentSessionId if the user switched sessions mid-run). Used by
 *  saveMessage as a legacy fallback when the renderer does not provide an
 *  explicit target. */
let promptSessionId: string | null = null;

interface InvocationContext {
  runId: string;
  turnId: string;
}

const activeInvocationBySession = new Map<string, InvocationContext>();
const invocationContexts = new Map<string, InvocationContext>();
const workerMessageQueues = new Map<string, Promise<void>>();
const projectionPersistQueues = new Map<string, Promise<Message[]>>();

function invocationKey(sessionId: string, runId: string): string {
  return `${sessionId}::${runId}`;
}

function rememberInvocation(
  sessionId: string,
  runId: string,
  turnId = randomUUID(),
): InvocationContext {
  const key = invocationKey(sessionId, runId);
  const existing = invocationContexts.get(key);
  if (existing) {
    activeInvocationBySession.set(sessionId, existing);
    return existing;
  }
  const context = { runId, turnId };
  invocationContexts.set(key, context);
  activeInvocationBySession.set(sessionId, context);
  return context;
}

function activeInvocation(sessionId: string): InvocationContext | undefined {
  return activeInvocationBySession.get(sessionId);
}

function forgetSessionInvocations(sessionId: string): void {
  activeInvocationBySession.delete(sessionId);
  for (const key of invocationContexts.keys()) {
    if (key.startsWith(`${sessionId}::`)) invocationContexts.delete(key);
  }
}

async function legacyMessagesForSession(sessionId: string): Promise<Message[]> {
  const cached = sessionMessages.get(sessionId);
  if (cached) return cached;
  return (await loadSession(sessionId))?.messages ?? [];
}

async function commitRuntimeFact(sessionId: string, draft: RuntimeEventDraft): Promise<void> {
  await appendRuntimeEvent(sessionId, draft, await legacyMessagesForSession(sessionId));
}

async function commitWorkerRuntimeFact(
  sessionId: string,
  draft: RuntimeEventDraft,
): Promise<boolean> {
  try {
    await commitRuntimeFact(sessionId, draft);
    return true;
  } catch (error) {
    if (!isRuntimeInvocationClosedError(error)) throw error;
    logger.warn('[RuntimeEvent] Ignored late fact for a closed invocation', {
      sessionId,
      runId: draft.runId,
      factType: draft.fact.type,
      existingStatus: error.existingStatus,
    });
    return false;
  }
}

function projectRuntimeSession(
  sessionId: string,
  events: Awaited<ReturnType<typeof readRuntimeEvents>>,
) {
  let projector = runtimeProjectors.get(sessionId);
  const projectedTail = projector?.lastSequence ? events[projector.lastSequence - 1] : undefined;
  if (
    !projector ||
    projector.lastSequence > events.length ||
    projector.lastEventId !== projectedTail?.eventId
  ) {
    projector = createSessionRuntimeProjector();
    runtimeProjectors.set(sessionId, projector);
  }
  return projector.append(events.slice(projector.lastSequence));
}

/** Stable non-crypto hash for deterministic guidance event IDs within a run. */
function stableTextToken(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Content-addressed suffix for deterministic event IDs whose payload can
 * legitimately change multiple times within one run (e.g. the system prompt
 * is rebuilt each turn). Same content → same event ID (idempotent replay);
 * changed content → a new event instead of a collision.
 */
function stableContentToken(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

async function persistRuntimeProjectionNow(sessionId: string): Promise<Message[]> {
  let meta = sessions.get(sessionId);
  if (!meta) {
    const disk = await loadSession(sessionId);
    meta = disk?.meta;
  }
  if (!meta) throw new Error(`Session not found: ${sessionId}`);

  const projection = projectRuntimeSession(sessionId, await readRuntimeEvents(sessionId));
  const cursorUnchanged = projectionCursorMatches(meta.runtimeProjection, projection.cursor);
  const countUnchanged = meta.messageCount === projection.messages.length;

  meta.runtimeProjection = projection.cursor;
  meta.messageCount = projection.messages.length;
  sessions.set(sessionId, meta);
  sessionMessages.set(sessionId, projection.messages);

  // Append-only ledger means an unchanged cursor implies unchanged projection.
  if (!cursorUnchanged || !countUnchanged) {
    meta.updated = new Date().toISOString();
    await saveSession(meta, projection.messages);
  }
  return projection.messages;
}

/** Serialize projection persistence per session so concurrent worker events do
 * not repeatedly read and rewrite the same session snapshot. */
async function persistRuntimeProjection(sessionId: string): Promise<Message[]> {
  const previous = projectionPersistQueues.get(sessionId) ?? Promise.resolve([]);
  const next = previous
    .catch((error) => {
      logger.warn('[RuntimeProjection] Previous persistence failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    })
    .then(() => persistRuntimeProjectionNow(sessionId));
  projectionPersistQueues.set(sessionId, next);

  try {
    return await next;
  } finally {
    if (projectionPersistQueues.get(sessionId) === next) {
      projectionPersistQueues.delete(sessionId);
    }
  }
}

async function terminateInvocation(
  sessionId: string,
  context: InvocationContext,
  status: RuntimeTerminationStatus,
  reason?: string,
  finalMessageEventId?: string,
): Promise<boolean> {
  return commitWorkerRuntimeFact(sessionId, {
    eventId: `${context.runId}:terminal`,
    runId: context.runId,
    turnId: context.turnId,
    invocationId: context.runId,
    fact: { type: 'invocation_terminated', status, finalMessageEventId, reason },
  });
}

function semanticDraftFromRunEvent(
  event: RunEvent,
  context: InvocationContext,
): RuntimeEventDraft | null {
  const base = {
    runId: context.runId,
    turnId: context.turnId,
    invocationId: context.runId,
  };
  switch (event.type) {
    case 'model_request_completed':
      if (event.requestKind === 'semantic_compact') return null;
      return {
        ...base,
        eventId: `${context.runId}:model-step:${event.turnNumber}:${event.attempt}`,
        fact: {
          type: 'model_step_committed',
          stepIndex: event.turnNumber,
          attempt: event.attempt,
          provider: event.provider,
          model: event.model,
          requestMessages: event.requestMessages ?? [],
          systemTokens: event.systemTokens ?? 0,
          responseText: event.responseText ?? '',
          responseThinking: event.responseThinking ?? '',
          responseToolCalls: event.responseToolCalls ?? [],
          stopReason: event.stopReason,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
        },
      };
    case 'semantic_compact_completed':
      // Compaction only rewrites the request view, never the durable message
      // list, so the projection keeps messages untouched. The fact is logged
      // for replay: reading the ledger reconstructs what the model actually
      // saw (which range was replaced by which projection).
      if (event.applied && event.mode === 'replace') {
        return {
          ...base,
          eventId: `${context.runId}:compaction:${event.projectionId}`,
          fact: {
            type: 'compaction_applied',
            turnNumber: event.turnNumber,
            mode: event.mode,
            projectionId: event.projectionId,
            previousProjectionId: event.previousProjectionId,
            sourceDigest: event.sourceDigest,
            sourceStartIndex: event.sourceStartIndex,
            sourceEndIndex: event.sourceEndIndex,
            projectionMessage: event.projectionMessage,
          },
        };
      }
      return null;
    default:
      return null;
  }
}

async function handleWorkerMessage(worker: Worker, msg: WorkerOutMessage): Promise<void> {
  console.log('[Main] Worker message:', msg.type);
  const sid = msg.sessionId;

  if (msg.type === 'runEvent') {
    const runtime: AppRuntimeIdentity = getAppRuntimeIdentity(worker.threadId);
    const evt = msg.event.type === 'run_started' ? { ...msg.event, runtime } : msg.event;
    if (evt.type === 'metadata') return;
    const context =
      evt.type === 'run_started'
        ? rememberInvocation(sid, evt.runId)
        : (invocationContexts.get(invocationKey(sid, evt.runId)) ??
          rememberInvocation(sid, evt.runId));

    if (evt.type === 'run_started') await startRun(sid, evt.runId, runtime);

    const semanticDraft = semanticDraftFromRunEvent(evt, context);
    if (semanticDraft) await commitWorkerRuntimeFact(sid, semanticDraft);

    if (evt.type === 'run_failed') {
      if (await terminateInvocation(sid, context, 'failed', evt.error)) {
        await persistRuntimeProjection(sid);
        await clearRuntimePartial(sid, context.runId);
      }
    } else if (evt.type === 'run_aborted') {
      if (await terminateInvocation(sid, context, 'aborted', 'user_stop')) {
        await persistRuntimeProjection(sid);
        await clearRuntimePartial(sid, context.runId);
      }
    } else if (evt.type === 'run_recovered') {
      if (await terminateInvocation(sid, context, 'interrupted', evt.reason)) {
        await persistRuntimeProjection(sid);
        await clearRuntimePartial(sid, context.runId);
      }
    }

    if (evt.type !== 'content.part') await appendEvent(sid, evt.runId, evt);

    // content.part is the token-level run feed. The renderer does not
    // consume it (handleRunEvent only handles model_request_completed), and it
    // already receives coalesced message_update snapshots through agent:stream.
    // Forwarding both paths doubles IPC traffic during long runs and can starve
    // the renderer event loop.
    if (evt.type === 'content.part') return;

    const mainWindow = windowManager?.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:run-event', { sessionId: sid, event: evt });
    }
    return;
  }

  const context = activeInvocation(sid);
  if (msg.type === 'stream' && msg.event.data && context) {
    scheduleRuntimePartial({
      sessionId: sid,
      runId: context.runId,
      turnId: context.turnId,
      updatedAt: new Date().toISOString(),
      data: msg.event.data,
    });
  }
  if (
    msg.type === 'stream' &&
    msg.event.type === 'system_prompt' &&
    msg.event.systemPrompt &&
    context
  ) {
    if (
      !(await commitWorkerRuntimeFact(sid, {
        eventId: `${context.runId}:system-prompt:${stableContentToken(msg.event.systemPrompt)}`,
        runId: context.runId,
        turnId: context.turnId,
        invocationId: context.runId,
        fact: { type: 'system_prompt_committed', systemPrompt: msg.event.systemPrompt },
      }))
    )
      return;
  } else if (msg.type === 'toolStart' && context) {
    if (
      !(await commitWorkerRuntimeFact(sid, {
        eventId: `${context.runId}:tool:${msg.toolCall.id}:call`,
        runId: context.runId,
        turnId: context.turnId,
        invocationId: context.runId,
        fact: { type: 'tool_call_committed', toolCall: msg.toolCall },
      }))
    )
      return;
  } else if (msg.type === 'toolEnd' && context) {
    if (
      !(await commitWorkerRuntimeFact(sid, {
        eventId: `${context.runId}:tool:${msg.toolResult.toolCallId}:result`,
        runId: context.runId,
        turnId: context.turnId,
        invocationId: context.runId,
        fact: { type: 'tool_result_committed', toolResult: msg.toolResult },
      }))
    )
      return;
  } else if (msg.type === 'done') {
    if (!context) {
      // Never invent a runId — orphan ledger facts are harder to repair than a
      // missing persistence of this single completion.
      logger.error('[RuntimeEvent] Ignoring done without active invocation', {
        sessionId: sid,
      });
    } else {
      const finalMessageEventId = `${context.runId}:final-assistant`;
      if (
        !(await commitWorkerRuntimeFact(sid, {
          eventId: finalMessageEventId,
          runId: context.runId,
          turnId: context.turnId,
          invocationId: context.runId,
          fact: { type: 'assistant_message_committed', message: msg.message },
        }))
      )
        return;
      if (!(await terminateInvocation(sid, context, 'completed', undefined, finalMessageEventId)))
        return;
      await persistRuntimeProjection(sid);
      await clearRuntimePartial(sid, context.runId);
    }
  }

  const mainWindow = windowManager?.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  switch (msg.type) {
    case 'stream':
      mainWindow.webContents.send('agent:stream', { sessionId: sid, event: msg.event });
      break;
    case 'status':
      mainWindow.webContents.send('agent:status', { sessionId: sid, status: msg.status });
      break;
    case 'error':
      console.error('[Main] Worker error:', msg.message, 'session=', sid.slice(-8));
      mainWindow.webContents.send('agent:error', { sessionId: sid, message: msg.message });
      break;
    case 'done':
      mainWindow.webContents.send('agent:done', { sessionId: sid, message: msg.message });
      break;
    case 'toolStart':
      mainWindow.webContents.send('agent:tool-start', { sessionId: sid, toolCall: msg.toolCall });
      break;
    case 'toolEnd':
      mainWindow.webContents.send('agent:tool-end', { sessionId: sid, toolResult: msg.toolResult });
      break;
    case 'toolProgress':
      mainWindow.webContents.send('agent:tool-progress', {
        sessionId: sid,
        toolCallId: msg.toolCallId,
        output: msg.output,
      });
      break;
    case 'bgProcessStarted':
      mainWindow.webContents.send('agent:bg-process-started', {
        sessionId: sid,
        process: msg.process,
      });
      break;
    case 'bgProcessCompleted':
      mainWindow.webContents.send('agent:bg-process-completed', {
        sessionId: sid,
        pid: msg.pid,
        exitCode: msg.exitCode,
      });
      break;
    case 'bgProcessPortsVerified':
      mainWindow.webContents.send('agent:bg-process-ports-verified', {
        sessionId: sid,
        pid: msg.pid,
        ports: msg.ports,
      });
      break;
    case 'subagentStart':
      mainWindow.webContents.send('agent:subagent-start', {
        sessionId: sid,
        execution: msg.execution,
      });
      break;
    case 'subagentEnd':
      mainWindow.webContents.send('agent:subagent-end', {
        sessionId: sid,
        id: msg.id,
        result: msg.result,
      });
      break;
    case 'subagentProgress':
      mainWindow.webContents.send('agent:subagent-progress', {
        sessionId: sid,
        executionId: msg.executionId,
        agent: msg.agent,
        delta: msg.delta,
      });
      break;
    case 'goalEvent':
      mainWindow.webContents.send('agent:goal-event', { sessionId: sid, event: msg.event });
      break;
  }
}

// ===== Agent Worker Management =====

function getAgentWorker(): Worker {
  if (!agentWorker) {
    const workerPath = join(__dirname, '../worker/agent-worker.js');
    console.log('[Main] Creating worker at:', workerPath);
    // Pass app data directory to worker via env so diagnostics and memories
    // land in the user directory, not the project directory.
    // Explicitly pass env via Worker constructor option rather than relying on
    // process.env inheritance — Vite's Worker bundling in dev mode can bypass
    // the default env propagation, causing SUNCODE_APP_DATA to be undefined
    // inside the Worker and all data to fall back to the project working dir.
    const worker = new Worker(workerPath, {
      env: {
        ...process.env,
        ...runtimeIdentityEnvironment(APP_RUNTIME_IDENTITY),
        SUNCODE_APP_DATA: getAppDataDir(),
        SUNCODE_IS_DEV: IS_DEV ? '1' : '0',
        SUNCODE_DOCS_DIR: IS_DEV
          ? join(app.getAppPath(), 'docs')
          : join(process.resourcesPath, 'docs'),
      },
    });
    agentWorker = worker;
    logger.info('[Worker] Created agent worker', getAppRuntimeIdentity(worker.threadId));

    worker.on('message', (msg: WorkerOutMessage) => {
      const previous = workerMessageQueues.get(msg.sessionId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => handleWorkerMessage(worker, msg))
        .catch((error: unknown) => {
          logger.error('[RuntimeEvent] Failed to commit worker message', error);
          const mainWindow = windowManager?.getMainWindow();
          mainWindow?.webContents.send('agent:error', {
            sessionId: msg.sessionId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      workerMessageQueues.set(msg.sessionId, next);
    });

    agentWorker.on('error', (error: Error) => {
      console.error('[Main] Worker error event:', error);
      const mainWindow = windowManager?.getMainWindow();
      mainWindow?.webContents.send('agent:error', error.message);
    });

    agentWorker.on('exit', (code: number) => {
      console.log(`[Main] Worker exited with code ${code}`);
      agentWorker = null;
    });

    // Send initial config — working dir is set later by session init
    sendToWorker({ type: 'config', settings: currentSettings });
  }
  return agentWorker;
}

function sendToWorker(msg: WorkerInMessage): void {
  const sid = (msg as Record<string, unknown>).sessionId as string | undefined;
  console.log('[Main] sendToWorker:', msg.type, 'sid=', sid?.slice(-8) || 'N/A');
  const worker = getAgentWorker();
  worker.postMessage(msg);
}

// ===== File Tree =====

const IGNORED = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.idea',
  '.vscode',
  '.DS_Store',
]);

async function buildFileTree(dirPath: string, maxDepth = 4): Promise<FileNode[]> {
  if (maxDepth <= 0) return [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    for (const entry of entries) {
      if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;

      const fullPath = join(dirPath, entry.name);
      const relPath = relative(process.cwd(), fullPath);

      if (entry.isDirectory()) {
        const children = await buildFileTree(fullPath, maxDepth - 1);
        if (children.length > 0) {
          nodes.push({
            name: entry.name,
            path: relPath,
            type: 'directory',
            children,
          });
        }
      } else if (entry.isFile()) {
        try {
          const info = await stat(fullPath);
          nodes.push({
            name: entry.name,
            path: relPath,
            type: 'file',
            size: info.size,
            modified: info.mtime.toISOString(),
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }

    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

// ===== Register IPC Handlers =====

let windowManager: WindowManager;

export function registerIpcHandlers(wm: WindowManager): void {
  windowManager = wm;

  // Ensure session storage directory exists
  initSessionStore();

  registerSettingsIpcHandlers({
    getSettings: () => currentSettings,
    setSettings: (settings) => {
      currentSettings = settings;
    },
    saveSettings,
    sendToWorker,
    getMainWindow: () => windowManager.getMainWindow(),
  });
  registerModelIpcHandlers();

  // Agent
  ipcMain.handle(
    'agent:prompt',
    async (
      _event,
      text: string,
      uiLanguage?: UiLanguage,
      requestedSessionId?: string,
      attachments: ImageAttachment[] = [],
    ) => {
      try {
        const attachmentError = validateImageAttachments(attachments);
        if (attachmentError) throw new Error(attachmentError);
        if (!text.trim() && attachments.length === 0) return;
        const sessionId = requestedSessionId || currentSessionId;
        if (!sessionId) return;
        console.log('[Main] agent:prompt received:', text.slice(0, 80));
        promptSessionId = sessionId; // Snap the owning session
        const runId = randomUUID();
        const turnId = randomUUID();
        rememberInvocation(sessionId, runId, turnId);
        const previousMessages = await legacyMessagesForSession(sessionId);
        const isFirstMessage = previousMessages.length === 0;
        const userMessage: Message = {
          role: 'user',
          content: [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...attachments.map((attachment) => ({
              type: 'image' as const,
              data: attachment.data,
              mimeType: attachment.mimeType,
            })),
          ],
          uiLanguage,
        };
        await commitRuntimeFact(sessionId, {
          eventId: `${runId}:user`,
          runId,
          turnId,
          invocationId: runId,
          fact: { type: 'user_message_committed', source: 'dispatch', message: userMessage },
        });
        await persistRuntimeProjection(sessionId);

        const meta = sessions.get(sessionId);
        if (meta && isFirstMessage) {
          const title = extractTitle(userMessage);
          if (title) {
            meta.name = title;
            await saveSession(meta, sessionMessages.get(sessionId) ?? []);
          }
          void generateTitleWithAI(sessionId, userMessage);
        }

        sendToWorker({
          type: 'prompt',
          sessionId,
          runId,
          turnId,
          text,
          uiLanguage,
          attachments,
        });
      } catch (err) {
        console.error('[Main] agent:prompt failed:', (err as Error).message);
        throw err;
      }
    },
  );

  ipcMain.on('agent:abort', () => {
    try {
      const sessionId = promptSessionId || currentSessionId;
      if (!sessionId) return;
      const context = activeInvocation(sessionId);
      if (!context) {
        sendToWorker({ type: 'abort', sessionId });
        return;
      }
      void commitRuntimeFact(sessionId, {
        eventId: `${context.runId}:stop-requested:hard`,
        runId: context.runId,
        turnId: context.turnId,
        invocationId: context.runId,
        fact: { type: 'invocation_stop_requested', source: 'hard_stop' },
      })
        .then(() => sendToWorker({ type: 'abort', sessionId }))
        .catch((error: unknown) =>
          logger.error('[RuntimeEvent] Failed to commit hard stop', error),
        );
    } catch (err) {
      console.error('[Main] agent:abort failed:', (err as Error).message);
    }
  });

  ipcMain.on('agent:injectGuidance', (_event, text: string, uiLanguage?: UiLanguage) => {
    try {
      const sessionId = currentSessionId;
      if (!sessionId) return;
      const context = activeInvocation(sessionId);
      if (!context) {
        sendToWorker({ type: 'injectGuidance', sessionId, text, uiLanguage });
        return;
      }
      void commitRuntimeFact(sessionId, {
        eventId: `${context.runId}:guidance:${stableTextToken(text)}`,
        runId: context.runId,
        turnId: context.turnId,
        invocationId: context.runId,
        fact: {
          type: 'user_message_committed',
          source: 'guidance',
          message: { role: 'user', content: [{ type: 'text', text }], uiLanguage },
        },
      })
        .then(() => persistRuntimeProjection(sessionId))
        .then(() => sendToWorker({ type: 'injectGuidance', sessionId, text, uiLanguage }))
        .catch((error: unknown) => {
          logger.error('[RuntimeEvent] Failed to commit guidance', error);
        });
    } catch (err) {
      console.error('[Main] agent:injectGuidance failed:', (err as Error).message);
    }
  });

  ipcMain.on('agent:stop', () => {
    try {
      const sessionId = promptSessionId || currentSessionId;
      if (!sessionId) return;
      const context = activeInvocation(sessionId);
      if (!context) {
        sendToWorker({ type: 'stop', sessionId });
        return;
      }
      void commitRuntimeFact(sessionId, {
        eventId: `${context.runId}:stop-requested:soft`,
        runId: context.runId,
        turnId: context.turnId,
        invocationId: context.runId,
        fact: { type: 'invocation_stop_requested', source: 'soft_stop' },
      })
        .then(() => sendToWorker({ type: 'stop', sessionId }))
        .catch((error: unknown) =>
          logger.error('[RuntimeEvent] Failed to commit soft stop', error),
        );
    } catch (err) {
      console.error('[Main] agent:stop failed:', (err as Error).message);
    }
  });

  ipcMain.on('agent:continue', () => {
    try {
      if (currentSessionId) sendToWorker({ type: 'continue', sessionId: currentSessionId });
    } catch (err) {
      console.error('[Main] agent:continue failed:', (err as Error).message);
    }
  });

  // Kill background process from renderer → worker
  ipcMain.on('agent:kill-bg-process', (_event, pid: number) => {
    try {
      if (currentSessionId)
        sendToWorker({ type: 'killBgProcess', sessionId: currentSessionId, pid });
    } catch (err) {
      console.error('[Main] agent:kill-bg-process failed:', (err as Error).message);
    }
  });

  // File tree
  ipcMain.handle('fs:getFileTree', async (_event, rootPath?: string) => {
    const dir = rootPath || process.cwd();
    return buildFileTree(dir);
  });

  // Read file
  ipcMain.handle(
    'fs:readFile',
    async (_event, filePath: string, offset?: number, limit?: number) => {
      const absPath = join(process.cwd(), filePath);
      try {
        const content = await readFile(absPath, 'utf-8');
        if (offset !== undefined || limit !== undefined) {
          const lines = content.split('\n');
          const start = offset || 0;
          const end = limit ? start + limit : lines.length;
          return lines.slice(start, end).join('\n');
        }
        return content;
      } catch (error) {
        const msg = (error as Error).message.replace(absPath, filePath);
        throw new Error(`Failed to read file: ${msg}`);
      }
    },
  );

  // Select directory
  ipcMain.handle('fs:selectDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Watch file
  ipcMain.on('fs:watchFile', (_event, filePath: string) => {
    const absPath = join(process.cwd(), filePath);
    if (watchers.has(absPath)) return;

    const watcher = fsWatch(absPath, async () => {
      try {
        const content = await readFile(absPath, 'utf-8');
        const mainWindow = windowManager.getMainWindow();
        mainWindow?.webContents.send(`fs:fileChanged:${filePath}`, content);
      } catch {
        // File might have been deleted
      }
    });

    watchers.set(absPath, () => watcher.close());
  });

  ipcMain.on('fs:unwatchFile', (_event, filePath: string) => {
    const absPath = join(process.cwd(), filePath);
    const cleanup = watchers.get(absPath);
    if (cleanup) {
      cleanup();
      watchers.delete(absPath);
    }
  });

  // Session management
  ipcMain.handle('session:list', async () => {
    const startedAt = performance.now();
    try {
      const diskSessions = await loadAllSessions();
      logger.debug('[SessionStore] Listed sessions', {
        sessionCount: diskSessions.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
      if (diskSessions.length > 0) {
        for (const meta of diskSessions) {
          sessions.set(meta.id, meta);
        }
        return diskSessions;
      }
      return Array.from(sessions.values());
    } catch (err) {
      console.error('[Main] session:list failed:', (err as Error).message);
      return Array.from(sessions.values());
    }
  });

  ipcMain.handle('session:create', async (_event, name: string, workingDirectory?: string) => {
    try {
      const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const meta: SessionMeta = {
        id,
        name,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        messageCount: 0,
        workingDirectory: workingDirectory || process.cwd(),
      };

      // Auto-create a Git worktree when:
      // 1. The user enabled `createGitWorktree` in settings
      // 2. The working directory is a Git repository
      // 3. The cwd is NOT already inside a linked worktree (nested worktrees
      //    are confusing and error-prone)
      if (currentSettings.createGitWorktree) {
        const worktreeDir = workingDirectory || process.cwd();
        if (isGitRepo(worktreeDir) && !isInsideWorktree(worktreeDir)) {
          const result = createWorktreeForSession(worktreeDir, id);
          if (result) {
            meta.workingDirectory = result.worktreePath;
            meta.gitWorktreeBranch = result.branch;
            meta.gitWorktreePath = result.worktreePath;
            meta.gitMainRepoPath = result.mainRepoPath;
            console.log(
              `[Main] Created worktree for session ${id.slice(-8)}: ${result.branch} @ ${result.worktreePath}`,
            );
          }
        }
      }

      sessions.set(id, meta);
      sessionMessages.set(id, []);
      await saveSession(meta, []);
      currentSessionId = id;
      sendToWorker({ type: 'setMessages', sessionId: id, messages: [] });
      sendToWorker({ type: 'setWorkingDir', sessionId: id, path: meta.workingDirectory });
      return meta;
    } catch (err) {
      console.error('[Main] session:create failed:', (err as Error).message);
      throw err;
    }
  });

  ipcMain.handle('session:load', async (_event, id: string, maxMessages?: number) => {
    const startedAt = performance.now();
    try {
      currentSessionId = id;
      // DO NOT clear promptSessionId here — a running agent may still need it
      // to save its response to the correct session.
      let messages = sessionMessages.get(id);
      let meta = sessions.get(id);

      const memCount = messages?.length ?? -1;
      // Always hydrate the main-process/worker state from the complete session.
      // The renderer-facing result is bounded below, so large histories never
      // cross IPC during the fast snapshot phase.
      const disk = await loadSession(id);
      const diskCount = disk?.messages.length ?? -1;

      if (disk) {
        // Prefer disk when it has more persisted messages than memory.
        // This guards against stale in-memory copies after mid-run switches.
        if (!messages || disk.messages.length > messages.length) {
          messages = disk.messages;
        }
        meta = disk.meta;
        // Validate Git worktree path: if the worktree directory was removed
        // externally (e.g. manual cleanup), fall back to the main repo path so
        // the session doesn't point at a dangling directory.
        if (meta.gitWorktreePath) {
          const validated = validateWorktreePath(meta.gitWorktreePath, meta.gitMainRepoPath);
          meta.workingDirectory = validated.workingDirectory;
          if (!validated.isValid) {
            // Clear worktree fields since the link is broken.
            meta.gitWorktreePath = undefined;
            meta.gitWorktreeBranch = undefined;
            meta.gitMainRepoPath = undefined;
          }
        }
        sessions.set(id, meta);
        sessionMessages.set(id, messages);
      }

      messages = messages || [];
      const runtimeEvents = await initializeRuntimeLedger(id, messages);
      let modelHistory = messages;
      if (runtimeEvents.length > 0 && meta) {
        const projection = projectRuntimeSession(id, runtimeEvents);
        messages = projection.messages;
        modelHistory = projection.messages;
        const cursorUnchanged = projectionCursorMatches(meta.runtimeProjection, projection.cursor);
        const countUnchanged = meta.messageCount === messages.length;
        meta.runtimeProjection = projection.cursor;
        meta.messageCount = messages.length;
        sessions.set(id, meta);
        sessionMessages.set(id, messages);
        // Avoid rewriting session.json on every session switch when the
        // projection cache is already current.
        if (!cursorUnchanged || !countUnchanged) {
          meta.updated = new Date().toISOString();
          await saveSession(meta, messages);
        }
      }
      const rendererMessages = limitMessages(messages, maxMessages);
      const resultCount = rendererMessages.length;
      console.log(
        `[Main] session:load id=${id.slice(-8)} mem=${memCount} disk=${diskCount} result=${resultCount} diskExists=${!!disk}`,
      );
      logger.debug('[SessionStore] Activated session', {
        sessionId: id,
        diskMessageCount: diskCount,
        resultMessageCount: resultCount,
        runtimeEventCount: runtimeEvents.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
      sendToWorker({ type: 'setMessages', sessionId: id, messages: modelHistory });
      if (meta) {
        sendToWorker({ type: 'setWorkingDir', sessionId: id, path: meta.workingDirectory });
      }
      return rendererMessages;
    } catch (err) {
      console.error('[Main] session:load failed:', (err as Error).message);
      return [];
    }
  });

  // Read-only fast path for first paint and background prewarming. It does not
  // switch the active session, hydrate Worker history, or replay the ledger.
  ipcMain.handle('session:loadSnapshot', async (_event, id: string, maxMessages = 10) => {
    const startedAt = performance.now();
    try {
      const disk = await loadSession(id, maxMessages);
      const messages = disk?.messages ?? [];
      logger.debug('[SessionStore] Loaded message snapshot', {
        sessionId: id,
        messageCount: messages.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return messages;
    } catch (err) {
      console.error('[Main] session:loadSnapshot failed:', (err as Error).message);
      return [];
    }
  });

  ipcMain.handle(
    'session:saveMessage',
    async (_event, message: Message, targetSessionId?: string) => {
      try {
        // Prefer the session captured by the renderer at dispatch time for
        // every role. Falling back to the current/prompt session keeps older
        // renderer payloads working without reintroducing cross-session writes.
        const targetSession =
          targetSessionId ||
          (message.role === 'user' ? currentSessionId : promptSessionId || currentSessionId);
        if (!targetSession) {
          console.log('[Main] saveMessage: SKIP (no session)');
          return;
        }
        const msgs = sessionMessages.get(targetSession) || [];
        console.log(
          `[Main] saveMessage role=${message.role} target=${targetSession.slice(-8)} cur=${currentSessionId?.slice(-8) ?? 'null'} prompt=${promptSessionId?.slice(-8) ?? 'null'} before=${msgs.length}`,
        );
        const isFirstMessage = msgs.length === 0;
        const context = activeInvocation(targetSession);
        const eventId = context
          ? message.role === 'assistant'
            ? `${context.runId}:final-assistant`
            : `${context.runId}:user`
          : `${targetSession}:legacy-message:${randomUUID()}`;
        await commitRuntimeFact(targetSession, {
          eventId,
          runId: context?.runId,
          turnId: context?.turnId,
          invocationId: context?.runId,
          fact:
            message.role === 'assistant'
              ? { type: 'assistant_message_committed', message }
              : { type: 'user_message_committed', source: 'dispatch', message },
        });
        await persistRuntimeProjection(targetSession);

        const meta = sessions.get(targetSession);
        if (meta && isFirstMessage && message.role === 'user') {
          // Quick fallback title from the first message text
          const title = extractTitle(message);
          if (title) {
            meta.name = title;
            await saveSession(meta, sessionMessages.get(targetSession) || []);
          }
          // Fire-and-forget: AI-generated title in the background
          void generateTitleWithAI(targetSession, message);
        }
      } catch (err) {
        console.error('[Main] session:saveMessage failed:', (err as Error).message);
      }
    },
  );

  ipcMain.handle('session:delete', async (_event, id: string) => {
    try {
      const meta = sessions.get(id);
      // Clean up Git worktree before tearing down session state.
      if (meta?.gitMainRepoPath && meta?.gitWorktreeBranch) {
        removeWorktreeForSession(
          meta.gitMainRepoPath,
          meta.gitWorktreeBranch,
          meta.gitWorktreePath,
        );
      }
      sessions.delete(id);
      sessionMessages.delete(id);
      runtimeProjectors.delete(id);
      forgetSessionInvocations(id);
      invalidateRuntimeEventCache(id);
      await deleteSession(id);
      const remaining = Array.from(sessions.values());
      const wasActive = currentSessionId === id;
      if (wasActive) currentSessionId = null;
      return { remaining, wasActive };
    } catch (err) {
      console.error('[Main] session:delete failed:', (err as Error).message);
      return { remaining: Array.from(sessions.values()), wasActive: false };
    }
  });

  ipcMain.handle('session:deleteMany', async (_event, ids: string[]) => {
    try {
      for (const id of ids) {
        const meta = sessions.get(id);
        // Clean up Git worktree for each session before removing it.
        if (meta?.gitMainRepoPath && meta?.gitWorktreeBranch) {
          removeWorktreeForSession(
            meta.gitMainRepoPath,
            meta.gitWorktreeBranch,
            meta.gitWorktreePath,
          );
        }
        sessions.delete(id);
        sessionMessages.delete(id);
        runtimeProjectors.delete(id);
        forgetSessionInvocations(id);
        invalidateRuntimeEventCache(id);
      }
      await deleteSessions(ids);
      const remaining = Array.from(sessions.values());
      const wasActive = Boolean(currentSessionId && ids.includes(currentSessionId));
      if (wasActive) currentSessionId = null;
      return { remaining, wasActive };
    } catch (err) {
      console.error('[Main] session:deleteMany failed:', (err as Error).message);
      return { remaining: Array.from(sessions.values()), wasActive: false };
    }
  });

  ipcMain.on('session:clearMessages', () => {
    const sid = currentSessionId;
    if (!sid) return;
    const before = sessionMessages.get(sid)?.length ?? 0;
    console.log(`[Main] session:clearMessages id=${sid.slice(-8)} before=${before}`);
    void commitRuntimeFact(sid, {
      eventId: `${sid}:clear:${randomUUID()}`,
      fact: { type: 'conversation_cleared' },
    })
      .then(() => persistRuntimeProjection(sid))
      .then((messages) => sendToWorker({ type: 'setMessages', sessionId: sid, messages }))
      .catch((error: unknown) => {
        logger.error('[RuntimeEvent] Failed to clear session projection', error);
      });
  });

  ipcMain.handle('session:export', async (_event, id: string) => {
    try {
      const msgs = sessionMessages.get(id) || [];
      const html = generateSessionHtml(msgs);
      const result = await dialog.showSaveDialog({
        filters: [{ name: 'HTML', extensions: ['html'] }],
      });
      if (!result.canceled && result.filePath) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(result.filePath, html, 'utf-8');
        return result.filePath;
      }
      return '';
    } catch (err) {
      console.error('[Main] session:export failed:', (err as Error).message);
      return '';
    }
  });

  // Skills listing --- scan built-in and compatible user-level skill files for the settings UI.
  ipcMain.handle('skills:list', async () => {
    try {
      const { existsSync } = await import('node:fs');
      const { readdir, readFile } = await import('node:fs/promises');
      const { extname, join } = await import('node:path');

      // Use app.isPackaged to determine the correct skills directory.
      // process.resourcesPath exists in Electron main even in dev, but points
      // to the Electron binary's resources (node_modules/electron/dist/resources),
      // NOT our project's skills/. Only use it when actually packaged.
      const builtinSkillsDir = app.isPackaged
        ? join(process.resourcesPath, 'skills')
        : join(__dirname, '..', '..', 'skills');

      const homeDir = process.env.HOME || process.env.USERPROFILE || '~';
      const directories = [
        { path: builtinSkillsDir, source: 'SunCode' },
        ...getVendorSkillDirectories(homeDir),
      ];
      const skills: DiscoveredSkill[] = [];

      for (const directory of directories) {
        if (!existsSync(directory.path)) continue;
        const entries = await readdir(directory.path, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
            // Flat .md file
            const filePath = join(directory.path, entry.name);
            const name = entry.name.replace('.md', '');
            let description = '';
            try {
              const content = await readFile(filePath, 'utf-8');
              const match = content.match(/^---\n[\s\S]*?description:\s*(.*?)\n/);
              if (match) {
                description = match[1]?.replace(/^["']|["']$/g, '').trim() ?? '';
              }
            } catch {}
            skills.push({ name, path: filePath, description, source: directory.source });
          } else if (entry.isDirectory()) {
            // Subdirectory with SKILL.md convention
            const skillFile = join(directory.path, entry.name, 'SKILL.md');
            try {
              const content = await readFile(skillFile, 'utf-8');
              const nameMatch = content.match(/^---\n[\s\S]*?name:\s*(.*?)\n/);
              const descMatch = content.match(/^---\n[\s\S]*?description:\s*(.*?)\n/);
              const name = nameMatch?.[1]?.trim() || entry.name;
              const description = descMatch?.[1]?.replace(/^["']|["']$/g, '').trim() ?? '';
              skills.push({ name, path: skillFile, description, source: directory.source });
            } catch {
              // No readable SKILL.md --- skip
            }
          }
        }
      }

      return skills;
    } catch (err) {
      console.error('[Main] skills:list failed:', (err as Error).message);
      return [];
    }
  });

  // ── Pending notification tracking ───────────────────────────────────
  // On Windows, Electron Notification.on('click') does not reliably fire
  // without a Start Menu shortcut whose System.AppUserModel.ID matches
  // app.setAppUserModelId (see ensureWindowsToastShortcut). As a fallback
  // we register window.once('focus') per notification — when activation
  // works, Windows focuses our existing window and the fallback runs.

  let pendingSessionId: string | null = null;
  let pendingClearTimer: ReturnType<typeof setTimeout> | null = null;
  /** Dedupe rapid agent:done → notify storms (same session within window). */
  const recentNotifyBySession = new Map<string, number>();
  const NOTIFY_DEDUPE_MS = 8_000;

  /** Navigate to the completed session (window focus + renderer message). */
  function navigateToSession(sessionId: string): void {
    try {
      const win = windowManager.getMainWindow();
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        win.webContents.send('notify:task-click', { sessionId });
      }
    } catch (err) {
      console.error('[Main] Failed to navigate on notification click:', (err as Error).message);
    }
  }

  /** Clear the pending notification state. */
  function clearPendingNotification(): void {
    pendingSessionId = null;
    if (pendingClearTimer) {
      clearTimeout(pendingClearTimer);
      pendingClearTimer = null;
    }
  }

  ipcMain.on('notify:task-complete', (_event, title: string, body: string, sessionId?: string) => {
    try {
      if (!Notification.isSupported()) {
        console.warn('[Main] Notifications not supported on this system');
        return;
      }

      // Collapse duplicate toasts for the same session (e.g. double done,
      // or both focus/unfocus races). Different sessions still notify.
      const dedupeKey = sessionId ?? `${title}\0${body}`;
      const now = Date.now();
      const last = recentNotifyBySession.get(dedupeKey);
      if (last !== undefined && now - last < NOTIFY_DEDUPE_MS) {
        console.log(
          '[Main] Skipping duplicate task-complete notification for session:',
          sessionId?.slice(-8) ?? 'none',
        );
        return;
      }
      recentNotifyBySession.set(dedupeKey, now);
      // Bound map growth
      if (recentNotifyBySession.size > 50) {
        for (const [key, ts] of recentNotifyBySession) {
          if (now - ts > NOTIFY_DEDUPE_MS) recentNotifyBySession.delete(key);
        }
      }

      const win = windowManager.getMainWindow();

      // Store pending session so the focus fallback can pick it up
      pendingSessionId = sessionId ?? null;

      // Auto-clear after 30 s to avoid stale navigation on normal focus
      if (pendingClearTimer) clearTimeout(pendingClearTimer);
      pendingClearTimer = setTimeout(() => {
        pendingSessionId = null;
      }, 30_000);

      // Focus fallback: register once per notification.
      // Windows always activates the window when a toast is clicked; the
      // 'focus' event here is our fallback if Notification.on('click')
      // does not fire (common on Windows).
      if (win && !win.isDestroyed()) {
        win.once('focus', () => {
          if (pendingSessionId) {
            const sid = pendingSessionId;
            clearPendingNotification();
            navigateToSession(sid);
          }
        });
      }

      const notification = new Notification({
        title,
        body,
        // Silent avoids stacked sound when several sessions finish close together
        silent: false,
      });
      notification.on('click', () => {
        clearPendingNotification();
        if (sessionId) navigateToSession(sessionId);
        else {
          const w = windowManager.getMainWindow();
          if (w && !w.isDestroyed()) {
            if (w.isMinimized()) w.restore();
            w.show();
            w.focus();
          }
        }
      });
      notification.show();

      console.log('[Main] Task-complete notification shown for session:', sessionId?.slice(-8));
    } catch (err) {
      console.error('[Main] Failed to show task completion notification:', (err as Error).message);
    }
  });

  // Confirm dialog
  ipcMain.handle('dialog:confirm', async (_event, title: string, message: string) => {
    const result = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Cancel', 'Confirm'],
      defaultId: 1,
      title,
      message,
    });
    return result.response === 1;
  });

  // App
  ipcMain.handle('app:getWorkingDir', async () => {
    return process.cwd();
  });

  ipcMain.handle('app:getVersion', async () => {
    return app.getVersion();
  });

  ipcMain.handle('app:getLogPath', async () => {
    return getLogPath();
  });

  // Get the absolute path of a session file (stored under app data dir, not working dir)
  ipcMain.handle('session:getFilePath', async (_event, sessionId: string) => {
    return getSessionFilePath(sessionId);
  });

  // Open a path in the system file explorer
  ipcMain.handle('shell:openPath', async (_event, targetPath: string) => {
    const result = await shell.openPath(targetPath);
    if (result) console.error('[Main] shell:openPath failed:', result, targetPath);
  });

  ipcMain.handle('shell:showItemInFolder', async (_event, fullPath: string) => {
    shell.showItemInFolder(fullPath);
  });

  // Window title bar overlay text
  ipcMain.on('window:setTitleBarOverlayText', (_event, text: string) => {
    const mainWindow = windowManager.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Updates the native window title (shown in title bar on all platforms)
      mainWindow.setTitle(text ? `SunCode — ${text}` : 'SunCode');
    }
  });

  // Sync window chrome colors and return the actual resolved theme.
  ipcMain.handle('window:setTheme', (_event, theme: AppSettings['theme']) => {
    nativeTheme.themeSource = theme;
    // Re-apply chrome so title-bar buttons stay aligned with theme or custom bg.
    applyWindowChrome(windowManager.getMainWindow());
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  });

  /**
   * Override native window chrome (title-bar min/max/close strip + window bg).
   * Pass null to restore theme-default chrome colors.
   */
  ipcMain.on(
    'window:setChromeColors',
    (_event, colors: { background: string; foreground: string } | null) => {
      setCustomWindowChrome(colors);
      applyWindowChrome(windowManager.getMainWindow());
    },
  );

  // ===== Git Info =====
  ipcMain.handle('git:getInfo', async (_event, workingDir: string) => {
    return getGitInfo(workingDir);
  });

  ipcMain.handle('git:listBranches', async (_event, workingDir: string) => {
    return listGitBranches(workingDir);
  });

  ipcMain.handle('git:checkoutBranch', async (_event, workingDir: string, branch: string) => {
    return checkoutGitBranch(workingDir, branch);
  });

  ipcMain.handle('git:getStagedDiff', async (_event, workingDir: string) => {
    try {
      return execFileSync('git', ['diff', '--staged'], {
        cwd: workingDir,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        timeout: 15000,
      });
    } catch {
      return '';
    }
  });

  ipcMain.handle('git:commit', async (_event, workingDir: string, message: string) => {
    try {
      // Check if there are staged changes
      const staged = execFileSync('git', ['diff', '--staged', '--name-only'], {
        cwd: workingDir,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        timeout: 10000,
      }).trim();

      if (!staged) {
        return { success: false, error: '没有暂存的更改。请先用 git add 暂存文件。' };
      }

      const output = execFileSync('git', ['commit', '-m', message], {
        cwd: workingDir,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        timeout: 30000,
      });
      return { success: true, output: output.trim() };
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      return { success: false, error: err.stderr || err.message || 'Commit failed' };
    }
  });

  ipcMain.handle('git:generateCommitMessage', async (_event, workingDir: string) => {
    try {
      const diff = execFileSync('git', ['diff', '--staged'], {
        cwd: workingDir,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        timeout: 15000,
      });
      if (!diff.trim()) return { message: 'chore: update' };

      const pi = await import('@earendil-works/pi-ai');
      // pi-ai uses template literal types for providers — cast to any for dynamic usage
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const model = pi.getModel(currentSettings.activeProvider as any, currentSettings.activeModel);
      // pi-ai's TS types for completeSimple params differ from its runtime API — safe to cast
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await pi.completeSimple(
        model as any,
        {
          system:
            'You are a commit message generator. Write a concise Conventional Commit message (e.g. "feat(scope): summary") based on the git diff. Use types: feat, fix, refactor, chore, docs, style, test. Keep it under 72 characters. Return ONLY the message, no quotes, no explanation.',
          messages: [
            {
              role: 'user',
              content: `Generate a Conventional Commit message for this diff:\n\n${diff.slice(0, 4000)}`,
            },
          ],
          tools: [],
        } as any,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content = (result as any).content;
      if (Array.isArray(content) && content.length > 0) {
        const textBlock = (content as Array<{ type: string; text?: string }>).find(
          (b) => b.type === 'text',
        );
        if (textBlock?.text) {
          return { message: textBlock.text.trim() };
        }
      }
      if (typeof content === 'string' && content.trim()) {
        return { message: content.trim() };
      }
      return { message: 'chore: update' };
    } catch {
      return { message: 'chore: update' };
    }
  });

  // ===== Token Usage Stats =====
  // The aggregate file is updated incrementally every time a run completes,
  // so opening the settings page only needs to read one small JSON file.
  ipcMain.handle('stats:getTokenUsage', async (): Promise<TokenUsageSummary> => {
    try {
      const aggregate = await getTokenUsageAggregate();
      const messageCount = await getTotalMessageCount();

      // Fallback: if the aggregate is empty (e.g. legacy install without the
      // aggregate file), build it once from existing run event logs.
      if (aggregate.totals.runs === 0) {
        return await buildTokenUsageSummaryFromRuns(messageCount);
      }

      return { ...aggregate, totals: { ...aggregate.totals, messages: messageCount } };
    } catch (err) {
      console.error('[Main] stats:getTokenUsage failed:', (err as Error).message);
      return {
        daily: [],
        byModel: [],
        totals: { input: 0, output: 0, total: 0, runs: 0, messages: 0 },
      };
    }
  });

  async function getTotalMessageCount(): Promise<number> {
    const diskSessions = await loadAllSessions();
    return diskSessions.reduce((total, session) => total + session.messageCount, 0);
  }

  async function buildTokenUsageSummaryFromRuns(messageCount: number): Promise<TokenUsageSummary> {
    const dailyMap = new Map<
      string,
      { input: number; output: number; total: number; runs: number }
    >();
    const modelMap = new Map<
      string,
      { input: number; output: number; total: number; runs: number }
    >();

    const diskSessions = await loadAllSessions();
    for (const session of diskSessions) {
      const runIds = await listRuns(session.id);
      let sessionModel = 'unknown';

      for (const runId of runIds) {
        const events = await getEvents(session.id, runId);

        // Extract model from run_started
        const started = events.find((e) => e.type === 'run_started');
        if (started && started.type === 'run_started' && started.modelName) {
          sessionModel = started.modelName;
        }

        // Extract token usage from run_completed
        const completed = events.find((e) => e.type === 'run_completed');
        if (completed && completed.type === 'run_completed' && completed.tokenUsage) {
          const { input, output, total } = completed.tokenUsage;
          const date = completed.timestamp.split('T')[0]!;

          // Aggregate daily
          const day = dailyMap.get(date) || { input: 0, output: 0, total: 0, runs: 0 };
          day.input += input;
          day.output += output;
          day.total += total;
          day.runs += 1;
          dailyMap.set(date, day);

          // Aggregate by model
          const model = modelMap.get(sessionModel) || { input: 0, output: 0, total: 0, runs: 0 };
          model.input += input;
          model.output += output;
          model.total += total;
          model.runs += 1;
          modelMap.set(sessionModel, model);
        }
      }
    }

    // Sort and build result
    const daily: DayStats[] = [...dailyMap.entries()]
      .map(([date, d]) => ({ date, ...d }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const byModel: ModelStats[] = [...modelMap.entries()]
      .map(([modelName, m]) => ({ modelName, ...m }))
      .sort((a, b) => b.total - a.total);

    const totals = {
      input: byModel.reduce((s, m) => s + m.input, 0),
      output: byModel.reduce((s, m) => s + m.output, 0),
      total: byModel.reduce((s, m) => s + m.total, 0),
      runs: byModel.reduce((s, m) => s + m.runs, 0),
      messages: messageCount,
    };

    return { daily, byModel, totals };
  }

  // ===== Auto Update =====

  ipcMain.handle('updater:getStatus', () => {
    return getUpdateStatus();
  });

  ipcMain.on('updater:check', () => {
    checkForUpdates();
  });

  ipcMain.on('updater:download', () => {
    downloadUpdate();
  });

  ipcMain.on('updater:install', () => {
    installUpdate();
  });

  ipcMain.on('updater:skip-version', (_event, version: string) => {
    skipVersion(version);
  });

  // ===== Memory Management =====
  ipcMain.handle('memory:get', async (_event, workingDir?: string, sessionId?: string) => {
    try {
      const { getAllMemories, migrateLegacyProjectMemories } = await import(
        '../worker/agent/memory'
      );
      const dir = workingDir || process.cwd();
      // One-time repair: fold project memories written under the legacy
      // un-normalized path hash into the normalized location.
      migrateLegacyProjectMemories(getAppDataDir(), dir);
      return getAllMemories(dir, sessionId);
    } catch (err) {
      console.error('[Main] memory:get failed:', (err as Error).message);
      return [];
    }
  });

  ipcMain.handle(
    'memory:save',
    async (_event, workingDir: string, memory: Record<string, unknown>, sessionId?: string) => {
      try {
        const { saveMemory, migrateLegacyProjectMemories } = await import('../worker/agent/memory');
        migrateLegacyProjectMemories(getAppDataDir(), workingDir || process.cwd());
        const entry = memory as {
          date: string;
          slug: string;
          userRequest: string;
          toolsUsed: Record<string, number>;
          summary: string;
          scope?: 'session' | 'project' | 'global';
          kind?:
            | 'task_summary'
            | 'project_fact'
            | 'decision'
            | 'preference'
            | 'lesson'
            | 'ephemeral';
          importance?: number;
          tags?: string[];
          expiresAt?: string;
          validFrom?: string;
          origin?: 'auto' | 'explicit' | 'manual';
          pinned?: boolean;
        };
        await saveMemory(
          workingDir,
          { ...entry, origin: entry.origin ?? 'manual' },
          undefined,
          undefined,
          sessionId,
        );
      } catch (err) {
        console.error('[Main] memory:save failed:', (err as Error).message);
        throw err;
      }
    },
  );

  ipcMain.handle(
    'memory:update',
    async (
      _event,
      workingDir: string,
      date: string,
      slug: string,
      updates: Record<string, unknown>,
      sessionId?: string,
    ) => {
      try {
        const { updateMemory } = await import('../worker/agent/memory');
        updateMemory(workingDir, date, slug, updates, sessionId);
      } catch (err) {
        console.error('[Main] memory:update failed:', (err as Error).message);
        throw err;
      }
    },
  );

  ipcMain.handle(
    'memory:delete',
    async (_event, workingDir: string, date: string, slug: string, sessionId?: string) => {
      try {
        const { deleteMemory } = await import('../worker/agent/memory');
        await deleteMemory(workingDir, date, slug, sessionId);
      } catch (err) {
        console.error('[Main] memory:delete failed:', (err as Error).message);
        throw err;
      }
    },
  );

  ipcMain.handle(
    'memory:search',
    async (_event, workingDir: string, query: string, sessionId?: string) => {
      try {
        const { getAllMemories, searchMemories } = await import('../worker/agent/memory');
        const dir = workingDir || process.cwd();
        const allEntries = getAllMemories(dir, sessionId);
        return searchMemories(allEntries, query);
      } catch (err) {
        console.error('[Main] memory:search failed:', (err as Error).message);
        return [];
      }
    },
  );

  ipcMain.handle(
    'memory:getDetail',
    async (_event, workingDir: string, date: string, slug: string, sessionId?: string) => {
      try {
        const { getAllMemories } = await import('../worker/agent/memory');
        const dir = workingDir || process.cwd();
        const entries = getAllMemories(dir, sessionId);
        return entries.find((e) => e.date === date && e.slug === slug) || null;
      } catch (err) {
        console.error('[Main] memory:getDetail failed:', (err as Error).message);
        return null;
      }
    },
  );

  ipcMain.handle('memory:getScenes', async (_event, workingDir?: string, sessionId?: string) => {
    try {
      const { getMemScenes } = await import('../worker/agent/memory');
      const dir = workingDir || process.cwd();
      return getMemScenes(dir, sessionId);
    } catch (err) {
      console.error('[Main] memory:getScenes failed:', (err as Error).message);
      return [];
    }
  });
}

/**
 * Extract a concise session title from the first user message.
 *
 * Uses the rules defined in TITLE_GENERATION_PROMPT:
 * - Use the user's primary language.
 * - Use 2-6 short words when possible.
 * - Keep the title to at most MAX_SESSION_TITLE_LENGTH characters.
 * - Keep it recognizable in a session list.
 * - Preserve important proper nouns, file names, APIs, and technology names.
 * - No markdown, numbering, quotes, trailing punctuation.
 *
 * For AI-based title generation, send the message content with
 * TITLE_GENERATION_PROMPT to a lightweight model. This fallback
 * extracts the first meaningful sentence and cleans it up.
 */
function extractTitle(message: Message): string | null {
  let text = '';

  if (typeof message.content === 'string') {
    text = message.content;
  } else {
    text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join(' ');
  }

  if (!text.trim()) return null;

  // Take the first non-empty line and strip common formatting
  const firstLine =
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';

  if (!firstLine) return null;

  // Clean up: remove markdown formatting, code fences, blockquotes, lists, and trailing punctuation
  let cleaned = firstLine
    .replace(/^[#>*-]+/, '') // strip leading markdown markers
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // strip inline code
    .replace(/[*_~]{1,2}/g, '') // strip bold/italic/strikethrough markers
    .replace(/[[\]()]/g, '') // strip link brackets
    .replace(/["「」『』"']/g, '') // strip quotes
    .replace(/[.。,，!！?？;；:：、]+$/, '') // strip trailing punctuation
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();

  if (!cleaned) return null;

  // Limit to ~7 words as per the prompt rules
  const words = cleaned.split(/\s+/);
  const maxWords = 7;
  if (words.length > maxWords) {
    cleaned = words.slice(0, maxWords).join(' ');
    // Avoid ending mid-sentence: remove trailing function words
    cleaned = cleaned.replace(
      /\s+(的|了|吗|呢|吧|啊|哦|嗯|和|与|或|the|a|an|in|on|at|to|for|of|and|or|but)$/i,
      '',
    );
  }

  // Truncate to a safe max length as final guard
  if (cleaned.length > MAX_SESSION_TITLE_LENGTH) {
    cleaned = cleaned
      .slice(0, MAX_SESSION_TITLE_LENGTH)
      .replace(/\s+\S*$/, '')
      .trim();
  }

  return cleaned || null;
}

/**
 * Generate a session title using AI via the configured model.
 * Runs asynchronously and updates the session name when complete.
 */
async function generateTitleWithAI(targetSession: string, userMessage: Message): Promise<void> {
  const text = extractText(userMessage);
  if (!text) return;

  const requestStartTime = Date.now();
  let requestError: string | undefined;

  try {
    const provider = currentSettings.activeProvider || 'deepseek';
    // Use a lightweight model on the same provider for cheap title generation.
    const modelId = LITE_MODELS[provider] || currentSettings.activeModel || 'deepseek-v4-flash';

    console.log(`[Main] Title AI: using lite model ${provider}/${modelId}`);

    const pi = await import('@earendil-works/pi-ai');
    const model = (pi as unknown as Record<string, unknown>).getModel
      ? (pi as unknown as { getModel: (p: string, m: string) => unknown }).getModel(
          provider,
          modelId,
        )
      : null;

    if (!model) {
      console.log('[Main] Title AI: model not available');
      return;
    }

    const stream = (
      pi as unknown as {
        streamSimple: (
          m: unknown,
          ctx: Record<string, unknown>,
          opts?: Record<string, unknown>,
        ) => AsyncIterable<{
          type: string;
          delta?: string;
          message?: { usage?: { input?: number; output?: number; totalTokens?: number } };
        }>;
      }
    ).streamSimple(
      model,
      {
        systemPrompt: TITLE_GENERATION_PROMPT,
        messages: [{ role: 'user', content: text }],
        tools: [],
      },
      { reasoning: 'minimal' },
    );

    let raw = '';
    let _inputTokens = 0;
    let _outputTokens = 0;
    let totalTokens = 0;
    for await (const event of stream) {
      if (event.type === 'text_delta' && event.delta) {
        raw += event.delta;
      }
      if (event.type === 'done' && event.message?.usage) {
        _inputTokens = event.message.usage.input || 0;
        _outputTokens = event.message.usage.output || 0;
        totalTokens = event.message.usage.totalTokens || 0;
      }
    }

    raw = raw.trim();
    // Parse JSON from the response (model may wrap in markdown code fences)
    const jsonMatch = raw.match(/\{[\s\S]*"title"[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('[Main] Title AI: no JSON found in response:', raw.slice(0, 80));
      return;
    }

    let title: string;
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { title?: string };
      title = (parsed.title || '').trim();
    } catch {
      console.log('[Main] Title AI: JSON parse failed:', jsonMatch[0].slice(0, 80));
      return;
    }

    if (!title) {
      console.log('[Main] Title AI: empty title');
      return;
    }

    // Clean up: remove markdown, quotes, trailing punctuation
    title = title
      .replace(/^["']|["']$/g, '')
      .replace(/[.。,，!！?？;；:：]+$/, '')
      .trim();
    if (title.length > MAX_SESSION_TITLE_LENGTH) {
      title = title
        .slice(0, MAX_SESSION_TITLE_LENGTH)
        .replace(/\s+\S*$/, '')
        .trim();
    }

    // Update session meta
    const meta = sessions.get(targetSession);
    if (meta) {
      meta.name = title;
      await saveSession(meta, sessionMessages.get(targetSession) || []);

      // Notify renderer
      const mainWindow = windowManager?.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session:updated', meta);
      }
    }
    const durationMs = Date.now() - requestStartTime;
    console.log(
      `[Main] AI title generated: "${title}" in ${durationMs}ms (tokens: ${totalTokens})`,
    );
  } catch (err) {
    requestError = (err as Error).message;
    console.error('[Main] Title generation failed:', requestError);
  } finally {
    if (requestError) {
      console.log(`[Main] Title AI request failed after ${Date.now() - requestStartTime}ms`);
    }
  }
}

function extractText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? block.text : ''))
    .join(' ');
}

function generateSessionHtml(messages: Message[]): string {
  const messageHtml = messages
    .map((msg) => {
      const content =
        typeof msg.content === 'string'
          ? escapeHtml(msg.content)
          : msg.content
              .map((block) => {
                if (block.type === 'text') return escapeHtml(block.text);
                if (block.type === 'thinking')
                  return `<details><summary>Thinking</summary>${escapeHtml(block.text)}</details>`;
                return '';
              })
              .join('');
      return `<div class="message ${msg.role}"><strong>${msg.role}</strong><div>${content}</div></div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SunCode Session Export</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #1e1e2e; color: #cdd6f4; padding: 20px; }
    .message { margin: 10px 0; padding: 10px; border-radius: 8px; }
    .user { background: #313244; }
    .assistant { background: #24273a; }
    strong { color: #89b4fa; text-transform: capitalize; }
    details { margin: 5px 0; color: #a6adc8; }
  </style>
</head>
<body>${messageHtml}</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
