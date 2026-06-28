/**
 * Agent Worker Thread — Entry point.
 * 每个 console.log 都会通过 parentPort 转发到主进程控制台。
 * 支持多 session 并发：每个 session 拥有独立的 Agent 实例。
 */
import { parentPort } from 'node:worker_threads';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { AppSettings, WorkerInMessage, WorkerOutMessage } from '@shared/types';
import { Agent } from './agent/agent';
import { killProcessTree } from './tools/bash';

if (!parentPort) {
  throw new Error('Agent worker must be run as a Worker thread');
}
const workerPort = parentPort;

console.log('[Worker] Started');

/** Per-session agent instances. Keyed by sessionId. */
const agents = new Map<string, Agent>();
let settings: AppSettings = { ...DEFAULT_SETTINGS };

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
    onError: (errorMsg: string) =>
      post({ type: 'error', sessionId, message: errorMsg }),
    onBgProcessStarted: (proc: import('@shared/types').BackgroundProcess) =>
      post({ type: 'bgProcessStarted', sessionId, process: proc }),
    onBgProcessCompleted: (pid: number, exitCode: number) =>
      post({ type: 'bgProcessCompleted', sessionId, pid, exitCode }),
    onBgProcessPortsVerified: (pid: number, ports: number[]) =>
      post({ type: 'bgProcessPortsVerified', sessionId, pid, ports }),
    onRunEvent: (event: import('@shared/types').RunEvent) =>
      post({ type: 'runEvent', sessionId, event }),
    onSubagentEvent: (
      type: string,
      data: unknown,
    ) => {
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
  console.log('[Worker] Received message:', msg.type);

  switch (msg.type) {
    case 'prompt': {
      const agent = getAgent(msg.sessionId);
      if (!agent) {
        console.error('[Worker] Agent not initialized for session:', msg.sessionId);
        post({ type: 'error', sessionId: msg.sessionId, message: 'Agent 未初始化。请先设置工作目录。' });
        return;
      }
      console.log('[Worker] Dispatching prompt:', msg.text.slice(0, 50), 'session=', msg.sessionId.slice(-8));
      try {
        await agent.prompt(msg.text);
        console.log('[Worker] Prompt completed session=', msg.sessionId.slice(-8));
      } catch (error) {
        console.error('[Worker] Prompt error:', error);
        post({ type: 'error', sessionId: msg.sessionId, message: (error as Error).message });
      }
      break;
    }

    case 'abort': {
      console.log('[Worker] Aborting session=', msg.sessionId.slice(-8));
      const agent = getAgent(msg.sessionId);
      agent?.abort();
      break;
    }

    case 'continue': {
      const agent = getAgent(msg.sessionId);
      if (!agent) return;
      console.log('[Worker] Continue session=', msg.sessionId.slice(-8));
      try {
        await agent.continue();
      } catch (error) {
        console.error('[Worker] Continue error:', error);
        post({ type: 'error', sessionId: msg.sessionId, message: (error as Error).message });
      }
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
      console.log('[Worker] Working dir set:', msg.path, 'session=', msg.sessionId.slice(-8));
      const existing = agents.get(msg.sessionId);
      if (existing) {
        await existing.setWorkingDir(msg.path);
        console.log('[Worker] Working dir updated session=', msg.sessionId.slice(-8));
      } else {
        const cbs = createCallbacks(msg.sessionId);
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
        );
        agents.set(msg.sessionId, newAgent);
        console.log('[Worker] Agent created session=', msg.sessionId.slice(-8));
      }
      break;
    }

    case 'setMessages': {
      const agent = getAgent(msg.sessionId);
      if (agent) {
        agent.setMessages(msg.messages);
        console.log('[Worker] Conversation context replaced:', msg.messages.length, 'messages', 'session=', msg.sessionId.slice(-8));
      } else {
        console.warn('[Worker] setMessages for unknown session:', msg.sessionId.slice(-8), '- no agent exists yet');
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
        killProcessTree(msg.pid);
      } catch (err) {
        console.error('[Worker] Failed to kill process:', (err as Error).message);
      }
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
