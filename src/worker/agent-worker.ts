/**
 * Agent Worker Thread — Entry point.
 * 每个 console.log 都会通过 parentPort 转发到主进程控制台。
 * 支持多 session 并发：每个 session 拥有独立的 Agent 实例。
 */
import { parentPort } from 'node:worker_threads';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { AppSettings, WorkerInMessage, WorkerOutMessage } from '@shared/types';
import { Agent } from './agent/agent';
import { BackgroundProcessMonitor } from './tools/background-process-monitor';
import { killProcessTree } from './tools/bash';

if (!parentPort) {
  throw new Error('Agent worker must be run as a Worker thread');
}
const workerPort = parentPort;

console.log('[Worker] Started');

/** Per-session agent instances. Keyed by sessionId. */
const agentWorkingDirs = new Map<string, string>();

/** Per-session agent instances. Keyed by sessionId. */
const agents = new Map<string, Agent>();
let settings: AppSettings = { ...DEFAULT_SETTINGS };
const backgroundProcessMonitor = new BackgroundProcessMonitor((item, exitCode) => {
  post({
    type: 'bgProcessCompleted',
    sessionId: item.sessionId,
    pid: item.process.pid,
    exitCode,
  });
});

/**
 * Per-session serialization lock.
 * Messages that mutate agent state (prompt, continue, abort, stop) are
 * serialized per session so that concurrent handleMessage invocations
 * cannot race on Agent.isRunning / abortController.
 */
const sessionLocks = new Map<string, Promise<void>>();

function withSessionLock(sessionId: string, fn: () => Promise<void>): void {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  // fn runs after prev completes, even if prev rejected
  const next = prev.then(fn, fn).then(() => {
    // Clean up the lock entry when this is still the latest chain link.
    if (sessionLocks.get(sessionId) === next) {
      sessionLocks.delete(sessionId);
    }
  });
  sessionLocks.set(sessionId, next);
}

/** Pending confirmations waiting for user response.
 *  Keyed by toolCallId (LLM-generated UUID, collision-safe across sessions). */
const pendingConfirmations = new Map<
  string,
  { resolve: (confirmed: boolean) => void; timeout: ReturnType<typeof setTimeout> }
>();

/** Request user confirmation before executing a destructive tool.
 *  Sends a message to the main process and waits for the response. */
function requestConfirmation(
  sessionId: string,
  toolCall: import('@shared/types').ToolCallContent,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingConfirmations.delete(toolCall.id);
      resolve(false); // Timeout: deny by default
    }, 120_000); // 2 minutes

    pendingConfirmations.set(toolCall.id, { resolve, timeout });
    post({ type: 'confirmRequest', sessionId, toolCall });
  });
}

function post(msg: WorkerOutMessage): void {
  workerPort.postMessage(msg);
}

function syncApiKeys(nextSettings: AppSettings): void {
  const envKeys: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GEMINI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    xai: 'XAI_API_KEY',
    groq: 'GROQ_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    together: 'TOGETHER_API_KEY',
    fireworks: 'FIREWORKS_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
  };

  for (const [provider, key] of Object.entries(nextSettings.envApiKeys || {})) {
    const envKey = envKeys[provider];
    if (envKey && key) {
      process.env[envKey] = key;
    }
  }
}

/**
 * Get or create an Agent for a given session.
 * The first call for a session must come via setWorkingDir to establish
 * the initial working directory.
 */
function getAgent(sessionId: string): Agent | undefined {
  return agents.get(sessionId);
}

/** Create per-session callbacks that stamp every outgoing message with sessionId. */
function createCallbacks(sessionId: string) {
  return {
    onStream: (event: import('@shared/types').StreamEvent) =>
      post({ type: 'stream', sessionId, event }),
    onStatus: (status: import('@shared/types').AgentStatus) =>
      post({ type: 'status', sessionId, status }),
    onToolStart: (toolCall: import('@shared/types').ToolCallContent) =>
      post({ type: 'toolStart', sessionId, toolCall }),
    onToolEnd: (toolResult: import('@shared/types').ToolResult) =>
      post({ type: 'toolEnd', sessionId, toolResult }),
    onToolProgress: (toolCallId: string, output: string) =>
      post({ type: 'toolProgress', sessionId, toolCallId, output }),
    onDone: (message: import('@shared/types').Message) =>
      post({ type: 'done', sessionId, message }),
    onError: (errorMsg: string) => post({ type: 'error', sessionId, message: errorMsg }),
    onBgProcessStarted: (proc: import('@shared/types').BackgroundProcess) => {
      backgroundProcessMonitor.register(sessionId, proc);
      post({ type: 'bgProcessStarted', sessionId, process: proc });
    },
    onBgProcessCompleted: (pid: number, exitCode: number) => {
      backgroundProcessMonitor.unregister(pid);
      post({ type: 'bgProcessCompleted', sessionId, pid, exitCode });
    },
    onBgProcessPortsVerified: (pid: number, ports: number[]) =>
      post({ type: 'bgProcessPortsVerified', sessionId, pid, ports }),
    onRunEvent: (event: import('@shared/types').RunEvent) =>
      post({ type: 'runEvent', sessionId, event }),
    onSubagentEvent: (type: string, data: unknown) => {
      const base = { sessionId, ...(data as Record<string, unknown>) };
      post({ type: type as WorkerOutMessage['type'], ...base } as WorkerOutMessage);
    },
    onGoalEvent: (event: import('@shared/types').GoalEvent) =>
      post({ type: 'goalEvent', sessionId, event }),
    requestConfirmation: (toolCall: import('@shared/types').ToolCallContent) =>
      requestConfirmation(sessionId, toolCall),
  };
}

async function handleMessage(msg: WorkerInMessage): Promise<void> {
  const sid = (msg as Record<string, unknown>).sessionId as string | undefined;
  console.log('[Worker] Received message:', msg.type, 'session=', sid?.slice(-8) || 'N/A');

  switch (msg.type) {
    case 'prompt': {
      const sid = msg.sessionId;
      if (!sid) {
        console.error('[Worker] prompt: missing sessionId');
        return;
      }
      const agent = getAgent(sid);
      if (!agent) {
        console.error('[Worker] Agent not initialized for session:', sid);
        post({ type: 'error', sessionId: sid, message: 'Agent 未初始化。请先设置工作目录。' });
        return;
      }
      console.log('[Worker] Dispatching prompt:', msg.text.slice(0, 50), 'session=', sid.slice(-8));
      withSessionLock(sid, async () => {
        try {
          await agent.prompt(msg.text, msg.uiLanguage);
          console.log('[Worker] Prompt completed session=', sid.slice(-8));
        } catch (error) {
          console.error('[Worker] Prompt error:', error);
          post({ type: 'error', sessionId: sid, message: (error as Error).message });
        }
      });
      break;
    }

    case 'abort': {
      const sid = msg.sessionId;
      if (!sid) {
        console.error('[Worker] abort: missing sessionId');
        return;
      }
      console.log('[Worker] Aborting session=', sid.slice(-8));
      // Direct call — no lock: abort() only sets a flag + calls abortController.abort(),
      // which is idempotent and must interrupt the running prompt immediately.
      getAgent(sid)?.abort();
      break;
    }

    case 'injectGuidance': {
      const sid = msg.sessionId;
      if (!sid) {
        console.error('[Worker] injectGuidance: missing sessionId');
        return;
      }
      // Direct call — no lock: injectGuidance() only pushes to a queue,
      // which is idempotent and must take effect at the next turn boundary.
      getAgent(sid)?.injectGuidance(msg.text, msg.uiLanguage);
      break;
    }

    case 'stop': {
      const sid = msg.sessionId;
      if (!sid) {
        console.error('[Worker] stop: missing sessionId');
        return;
      }
      console.log('[Worker] Soft-stopping session=', sid.slice(-8));
      // Direct call — no lock: requestStop() only sets a flag + calls abortController.abort(),
      // which is idempotent and must interrupt the running prompt immediately.
      getAgent(sid)?.requestStop();
      break;
    }

    case 'continue': {
      const sid = msg.sessionId;
      if (!sid) {
        console.error('[Worker] continue: missing sessionId');
        return;
      }
      const agent = getAgent(sid);
      if (!agent) return;
      console.log('[Worker] Continue session=', sid.slice(-8));
      withSessionLock(sid, async () => {
        try {
          await agent.continue();
        } catch (error) {
          console.error('[Worker] Continue error:', error);
          post({ type: 'error', sessionId: sid, message: (error as Error).message });
        }
      });
      break;
    }

    case 'config': {
      console.log('[Worker] Config updated, activeModel=', msg.settings.activeModel);
      settings = msg.settings;
      syncApiKeys(settings);
      // Update settings on ALL agents
      for (const agent of agents.values()) {
        agent.updateSettings(msg.settings);
      }
      break;
    }

    case 'setWorkingDir': {
      const sid = msg.sessionId;
      if (!sid) {
        console.error('[Worker] setWorkingDir: missing sessionId');
        return;
      }
      // Skip if the working directory hasn't changed
      if (agentWorkingDirs.get(sid) === msg.path) {
        console.log('[Worker] Working dir unchanged, skip session=', sid.slice(-8));
        return;
      }
      agentWorkingDirs.set(sid, msg.path);
      console.log('[Worker] Working dir set:', msg.path, 'session=', sid.slice(-8));
      withSessionLock(sid, async () => {
        const existing = agents.get(sid);
        if (existing) {
          await existing.setWorkingDir(msg.path);
          console.log('[Worker] Working dir updated session=', sid.slice(-8));
        } else {
          const cbs = createCallbacks(sid);
          const newAgent = new Agent(
            msg.path,
            settings,
            cbs.onStream,
            cbs.onStatus,
            cbs.onToolStart,
            cbs.onToolEnd,
            cbs.onToolProgress,
            cbs.onDone,
            cbs.onError,
            cbs.onBgProcessStarted,
            cbs.onBgProcessCompleted,
            cbs.onBgProcessPortsVerified,
            cbs.onRunEvent,
            cbs.onSubagentEvent,
            cbs.onGoalEvent,
            cbs.requestConfirmation,
            sid,
          );
          agents.set(sid, newAgent);
          console.log('[Worker] Agent created session=', sid.slice(-8));
        }
      });
      break;
    }

    case 'setMessages': {
      const sid = msg.sessionId;
      if (!sid) {
        console.error('[Worker] setMessages: missing sessionId');
        return;
      }
      const agent = getAgent(sid);
      if (agent) {
        agent.setMessages(msg.messages);
        console.log(
          '[Worker] Conversation context replaced:',
          msg.messages.length,
          'messages',
          'session=',
          sid.slice(-8),
        );
      } else {
        console.warn(
          '[Worker] setMessages for unknown session:',
          sid.slice(-8),
          '- no agent exists yet',
        );
      }
      break;
    }

    case 'confirmResponse': {
      const pending = pendingConfirmations.get(msg.toolCallId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingConfirmations.delete(msg.toolCallId);
        pending.resolve(msg.confirmed);
      }
      break;
    }

    case 'killBgProcess': {
      console.log('[Worker] Killing background process:', msg.pid);
      try {
        killProcessTree(backgroundProcessMonitor.getMonitorPid(msg.pid) ?? msg.pid);
      } catch (err) {
        console.error('[Worker] Failed to kill process:', (err as Error).message);
      }
      backgroundProcessMonitor.unregister(msg.pid);
      // Notify renderer that the process was terminated externally
      post({ type: 'bgProcessCompleted', sessionId: msg.sessionId, pid: msg.pid, exitCode: -1 });
      break;
    }

    default:
      console.warn('[Worker] Unknown message type:', (msg as { type: string }).type);
  }
}

workerPort.on('message', (msg: WorkerInMessage) => {
  handleMessage(msg).catch((err) => {
    console.error('[Worker] Unhandled error:', err);
    post({ type: 'error', sessionId: '', message: err.message });
  });
});
