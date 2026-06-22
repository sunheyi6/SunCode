import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, watch, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type {
  AppSettings,
  FileNode,
  Message,
  SessionMeta,
  WorkerInMessage,
  WorkerOutMessage,
} from '@shared/types';
import { app, dialog, ipcMain } from 'electron';
import type { WindowManager } from './window-manager';
import { getGitInfo } from './git-info';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ===== Settings Persistence — 保存在项目目录 =====
const CONFIG_DIR = join(process.cwd(), '.suncode');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

function loadSettings(): AppSettings {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const saved = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...saved };
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
const sessions: Map<string, SessionMeta> = new Map();
const sessionMessages: Map<string, Message[]> = new Map();
let currentSessionId: string | null = null;

// ===== Agent Worker Management =====

function getAgentWorker(): Worker {
  if (!agentWorker) {
    const workerPath = join(__dirname, '../worker/agent-worker.js');
    console.log('[Main] Creating worker at:', workerPath);
    agentWorker = new Worker(workerPath);

    agentWorker.on('message', (msg: WorkerOutMessage) => {
      console.log('[Main] Worker message:', msg.type);
      const mainWindow = windowManager?.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;

      switch (msg.type) {
        case 'stream':
          mainWindow.webContents.send('agent:stream', msg.event);
          break;
        case 'status':
          mainWindow.webContents.send('agent:status', msg.status);
          break;
        case 'error':
          console.error('[Main] Worker error:', msg.message);
          mainWindow.webContents.send('agent:error', msg.message);
          break;
        case 'done':
          mainWindow.webContents.send('agent:done', msg.message);
          break;
        case 'toolStart':
          mainWindow.webContents.send('agent:tool-start', msg.toolCall);
          break;
        case 'toolEnd':
          mainWindow.webContents.send('agent:tool-end', msg.toolResult);
          break;
        case 'bgProcessStarted':
          mainWindow.webContents.send('agent:bg-process-started', msg.process);
          break;
        case 'bgProcessCompleted':
          mainWindow.webContents.send('agent:bg-process-completed', msg.pid, msg.exitCode);
          break;
      }
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

    // Send initial config and working dir
    sendToWorker({ type: 'config', settings: currentSettings });
    sendToWorker({ type: 'setWorkingDir', path: process.cwd() });
  }
  return agentWorker;
}

function sendToWorker(msg: WorkerInMessage): void {
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

  // Agent
  ipcMain.on('agent:prompt', (_event, text: string) => {
    console.log('[Main] agent:prompt received:', text.slice(0, 80));
    sendToWorker({ type: 'prompt', text });
  });

  ipcMain.on('agent:abort', () => {
    sendToWorker({ type: 'abort' });
  });

  ipcMain.on('agent:continue', () => {
    sendToWorker({ type: 'continue' });
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
      try {
        const absPath = join(process.cwd(), filePath);
        const content = await readFile(absPath, 'utf-8');
        if (offset !== undefined || limit !== undefined) {
          const lines = content.split('\n');
          const start = offset || 0;
          const end = limit ? start + limit : lines.length;
          return lines.slice(start, end).join('\n');
        }
        return content;
      } catch (error) {
        throw new Error(`Failed to read file: ${(error as Error).message}`);
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

    const watcher = watch(absPath, async () => {
      try {
        const content = await readFile(absPath, 'utf-8');
        const mainWindow = windowManager.getMainWindow();
        mainWindow?.webContents.send(`fs:fileChanged:${filePath}`, content);
      } catch {
        // File might have been deleted
      }
    });

    watchers.set(absPath, () => watcher.then((w) => w.close()));
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
    return Array.from(sessions.values());
  });

  ipcMain.handle('session:create', async (_event, name: string, workingDirectory?: string) => {
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const meta: SessionMeta = {
      id,
      name,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      messageCount: 0,
      workingDirectory: workingDirectory || process.cwd(),
    };
    sessions.set(id, meta);
    sessionMessages.set(id, []);
    currentSessionId = id;
    sendToWorker({ type: 'setMessages', messages: [] });
    return meta;
  });

  ipcMain.handle('session:load', async (_event, id: string) => {
    currentSessionId = id;
    const messages = sessionMessages.get(id) || [];
    const meta = sessions.get(id);
    sendToWorker({ type: 'setMessages', messages });
    if (meta) {
      sendToWorker({ type: 'setWorkingDir', path: meta.workingDirectory });
    }
    return messages;
  });

  ipcMain.handle('session:saveMessage', async (_event, message: Message) => {
    if (!currentSessionId) return;
    const msgs = sessionMessages.get(currentSessionId) || [];
    const isFirstMessage = msgs.length === 0;
    msgs.push(message);
    sessionMessages.set(currentSessionId, msgs);

    const meta = sessions.get(currentSessionId);
    if (meta) {
      meta.updated = new Date().toISOString();
      meta.messageCount = msgs.length;

      // Auto-title: use the first user message as the conversation title
      if (isFirstMessage && message.role === 'user') {
        const title = extractTitle(message);
        if (title) {
          meta.name = title;
        }
      }
    }
  });

  ipcMain.handle('session:export', async (_event, id: string) => {
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
  });

  // Settings
  ipcMain.handle('settings:get', async () => {
    console.log(
      '[Main] settings:get called, envApiKeys:',
      Object.keys(currentSettings.envApiKeys || {}),
    );
    return currentSettings;
  });

  ipcMain.handle('settings:update', async (_event, partial: Partial<AppSettings>) => {
    currentSettings = { ...currentSettings, ...partial };

    // ===== 关键：同步 API Key 到环境变量 =====
    if (partial.envApiKeys) {
      for (const [provider, key] of Object.entries(partial.envApiKeys)) {
        const envKey = getProviderEnvKey(provider);
        if (envKey && key) {
          process.env[envKey] = key;
        }
      }
    }

    sendToWorker({ type: 'config', settings: currentSettings });
    const mainWindow = windowManager.getMainWindow();
    mainWindow?.webContents.send('settings:changed', currentSettings);
    // ===== 持久化到磁盘 =====
    saveSettings(currentSettings);
    return currentSettings;
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

  // Working directory
  ipcMain.handle('app:getWorkingDir', async () => {
    return process.cwd();
  });

  // ===== Git Info =====
  ipcMain.handle('git:getInfo', async (_event, workingDir: string) => {
    return getGitInfo(workingDir);
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

  ipcMain.handle(
    'git:generateCommitMessage',
    async (_event, workingDir: string) => {
      try {
        const diff = execFileSync('git', ['diff', '--staged'], {
          cwd: workingDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
          timeout: 15000,
        });
        if (!diff.trim()) return { message: 'chore: update' };

        const pi = await import('@earendil-works/pi-ai');
        const model = pi.getModel(currentSettings.activeProvider, currentSettings.activeModel);
        const result = await pi.completeSimple(model, {
          system:
            'You are a commit message generator. Write a concise Conventional Commit message (e.g. "feat(scope): summary") based on the git diff. Use types: feat, fix, refactor, chore, docs, style, test. Keep it under 72 characters. Return ONLY the message, no quotes, no explanation.',
          messages: [
            {
              role: 'user',
              content: `Generate a Conventional Commit message for this diff:\n\n${diff.slice(0, 4000)}`,
            },
          ],
          tools: [],
        });

        if (Array.isArray(result.content) && result.content.length > 0) {
          const textBlock = result.content.find(
            (b: { type: string; text?: string }) => b.type === 'text',
          );
          if (textBlock && 'text' in textBlock && textBlock.text) {
            return { message: textBlock.text.trim() };
          }
        }
        if (typeof result.content === 'string' && result.content.trim()) {
          return { message: result.content.trim() };
        }
        return { message: 'chore: update' };
      } catch {
        return { message: 'chore: update' };
      }
    },
  );

  // ===== Model Discovery =====
  ipcMain.handle('models:getProviders', async () => {
    try {
      const { getProviders } = await import('@earendil-works/pi-ai');
      return getProviders();
    } catch {
      // Fallback providers if pi-ai is unavailable
      return ['anthropic', 'openai', 'google', 'deepseek', 'xai', 'groq', 'mistral', 'openrouter'];
    }
  });

  ipcMain.handle('models:getModels', async (_event, provider: string) => {
    try {
      const { getModels } = await import('@earendil-works/pi-ai');
      const models = getModels(provider);
      return models.map((m: Record<string, unknown>) => ({
        id: m.id as string,
        name: m.name as string,
        provider: (m.provider as string) || provider,
        contextWindow: (m.contextWindow as number) || 128000,
        maxTokens: (m.maxTokens as number) || 4096,
        supportsReasoning: Boolean(m.reasoning),
        supportsImages: Array.isArray(m.input) && (m.input as string[]).includes('image'),
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('models:getRecommended', async () => {
    return [
      { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { provider: 'anthropic', model: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
      { provider: 'openai', model: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
      { provider: 'openai', model: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { provider: 'google', model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
      { provider: 'deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { provider: 'xai', model: 'grok-code-fast-1', label: 'Grok Code Fast' },
      {
        provider: 'openrouter',
        model: 'openai/gpt-5.1-codex',
        label: 'GPT-5.1 Codex (OpenRouter)',
      },
      {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4-5',
        label: 'Claude Sonnet 4.5 (OpenRouter)',
      },
    ];
  });

  // ===== API Keys =====
  ipcMain.handle('settings:setApiKey', async (_event, provider: string, key: string) => {
    // Store in process env for the agent worker
    const envKey = getProviderEnvKey(provider);
    if (envKey) {
      process.env[envKey] = key;
    }
    // Also store in settings
    currentSettings.envApiKeys[provider] = key;
    sendToWorker({ type: 'config', settings: currentSettings });
    saveSettings(currentSettings);
    return true;
  });

  ipcMain.handle('settings:getApiKeys', async () => {
    const keys: Record<string, string> = {};
    for (const [provider] of Object.entries(currentSettings.envApiKeys)) {
      const envKey = getProviderEnvKey(provider);
      keys[provider] = envKey ? process.env[envKey] || '' : '';
    }
    return keys;
  });
}

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

  // Take the first line, trim, and truncate
  const firstLine = text.split('\n')[0].trim();
  if (!firstLine) return null;

  const maxLen = 30;
  return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen)}...` : firstLine;
}

function getProviderEnvKey(provider: string): string | undefined {
  const keyMap: Record<string, string> = {
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
    'kimi-coding': 'KIMI_API_KEY',
    moonshotai: 'MOONSHOT_API_KEY',
    minimax: 'MINIMAX_API_KEY',
  };
  return keyMap[provider];
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
