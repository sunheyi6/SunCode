/**
 * Agent Worker Thread — Entry point.
 * 每个 console.log 都会通过 parentPort 转发到主进程控制台。
 */
import { parentPort } from 'node:worker_threads';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { AppSettings, WorkerInMessage, WorkerOutMessage } from '@shared/types';
import { Agent } from './agent/agent';

if (!parentPort) {
  throw new Error('Agent worker must be run as a Worker thread');
}
const workerPort = parentPort;

console.log('[Worker] Started');

let agent: Agent | null = null;
let settings: AppSettings = { ...DEFAULT_SETTINGS };

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

async function handleMessage(msg: WorkerInMessage): Promise<void> {
  console.log('[Worker] Received message:', msg.type);

  switch (msg.type) {
    case 'prompt': {
      if (!agent) {
        console.error('[Worker] Agent not initialized — no working dir set');
        post({ type: 'error', message: 'Agent 未初始化。请先设置工作目录。' });
        return;
      }
      console.log('[Worker] Dispatching prompt:', msg.text.slice(0, 50));
      try {
        await agent.prompt(msg.text);
        console.log('[Worker] Prompt completed');
      } catch (error) {
        console.error('[Worker] Prompt error:', error);
        post({ type: 'error', message: (error as Error).message });
      }
      break;
    }

    case 'abort': {
      console.log('[Worker] Aborting');
      agent?.abort();
      break;
    }

    case 'continue': {
      console.log('[Worker] Continue');
      if (!agent) return;
      try {
        await agent.continue();
      } catch (error) {
        console.error('[Worker] Continue error:', error);
        post({ type: 'error', message: (error as Error).message });
      }
      break;
    }

    case 'config': {
      console.log('[Worker] Config updated, activeModel=', msg.settings.activeModel);
      settings = msg.settings;
      // Worker threads receive an environment snapshot when they are created.
      // Apply keys again so keys saved after worker startup are available to pi-ai.
      syncApiKeys(settings);
      if (agent) {
        agent.updateSettings(msg.settings);
      }
      break;
    }

    case 'setWorkingDir': {
      console.log('[Worker] Working dir set:', msg.path);
      if (agent) {
        // Update existing agent without recreating it
        await agent.setWorkingDir(msg.path);
        console.log('[Worker] Working dir updated');
      } else {
        // First-time initialization
        agent = new Agent(
          msg.path,
          settings,
          (event) => post({ type: 'stream', event }),
          (status) => post({ type: 'status', status }),
          (toolCall) => post({ type: 'toolStart', toolCall }),
          (toolResult) => post({ type: 'toolEnd', toolResult }),
          (message) => post({ type: 'done', message }),
          (errorMsg) => post({ type: 'error', message: errorMsg }),
          (proc) => post({ type: 'bgProcessStarted', process: proc }),
          (pid, exitCode) => post({ type: 'bgProcessCompleted', pid, exitCode }),
          (event) => post({ type: 'runEvent', event }),
          (type, data) => post({ type: type as WorkerOutMessage['type'], ...(data as Record<string, unknown>) } as WorkerOutMessage),
        );
        console.log('[Worker] Agent created');
      }
      break;
    }

    case 'setMessages': {
      agent?.setMessages(msg.messages);
      console.log('[Worker] Conversation context replaced:', msg.messages.length, 'messages');
      break;
    }

    default:
      console.warn('[Worker] Unknown message type:', (msg as { type: string }).type);
  }
}

workerPort.on('message', (msg: WorkerInMessage) => {
  handleMessage(msg).catch((err) => {
    console.error('[Worker] Unhandled error:', err);
    post({ type: 'error', message: err.message });
  });
});
