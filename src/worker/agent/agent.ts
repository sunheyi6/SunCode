import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentStatus,
  AppSettings,
  BackgroundProcess,
  Message,
  RunEvent,
  StreamEvent,
  ToolCallContent,
  ToolResult,
} from '@shared/types';
import { loadMemories, saveMemory, type MemoryEntry } from './memory';
import { createMcpManager } from '../mcp/manager';
import { createModelRegistry } from '../models/registry';
import { createToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import { runAgentLoop } from './agent-loop';
import { createSkillsLoader } from './skills';

export class Agent {
  private workingDir: string;
  private settings: AppSettings;
  private tools: Tool[] = [];
  private messages: Message[] = [];
  private abortController: AbortController | null = null;
  private isRunning = false;
  private turnCount = 0;
  private totalTokens = { input: 0, output: 0, total: 0 };

  private onStream: (event: StreamEvent) => void;
  private onStatus: (status: AgentStatus) => void;
  private onToolStart: (toolCall: ToolCallContent) => void;
  private onToolEnd: (result: ToolResult) => void;
  private onDone: (message: Message) => void;
  private onError: (message: string) => void;
  private onBackgroundStart: (proc: BackgroundProcess) => void;
  private onBackgroundComplete: (pid: number, exitCode: number) => void;
  private onRunEvent: (event: RunEvent) => void;

  constructor(
    workingDir: string,
    settings: AppSettings,
    onStream: (event: StreamEvent) => void,
    onStatus: (status: AgentStatus) => void,
    onToolStart: (toolCall: ToolCallContent) => void,
    onToolEnd: (result: ToolResult) => void,
    onDone: (message: Message) => void,
    onError: (message: string) => void,
    onBackgroundStart: (proc: BackgroundProcess) => void,
    onBackgroundComplete: (pid: number, exitCode: number) => void,
    onRunEvent: (event: RunEvent) => void,
  ) {
    this.workingDir = workingDir;
    this.settings = settings;
    this.onStream = onStream;
    this.onStatus = onStatus;
    this.onToolStart = onToolStart;
    this.onToolEnd = onToolEnd;
    this.onDone = onDone;
    this.onError = onError;
    this.onBackgroundStart = onBackgroundStart;
    this.onBackgroundComplete = onBackgroundComplete;
    this.onRunEvent = onRunEvent;

    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      // Load built-in tools (with background process callbacks)
      const registry = createToolRegistry(this.workingDir, {
        onBackgroundStart: (proc) => this.onBackgroundStart(proc),
        onBackgroundComplete: (pid, code) => this.onBackgroundComplete(pid, code),
      });
      this.tools = registry.getAll();

      // Load MCP tools
      const mcpManager = createMcpManager(this.settings.mcpServers);
      const mcpTools = await mcpManager.connectAll();
      this.tools.push(...mcpTools);

      // Load skills
      const skillsLoader = createSkillsLoader(this.workingDir, this.settings.skills);
      const skillsContent = await skillsLoader.loadAll();

      console.log(
        `Agent initialized: ${this.tools.length} tools, ${skillsContent.length} skills chars`,
      );
    } catch (error) {
      console.error('Agent initialization error:', error);
    }
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
  }

  /**
   * Change the working directory without recreating the entire agent.
   * Rebuilds built-in tools to enforce the new sandbox boundary.
   * MCP tools and message history are preserved.
   */
  setWorkingDir(path: string): void {
    if (this.workingDir === path) return;
    this.workingDir = path;

    // Rebuild built-in tools with the new working directory
    const registry = createToolRegistry(path, {
      onBackgroundStart: (proc) => this.onBackgroundStart(proc),
      onBackgroundComplete: (pid, code) => this.onBackgroundComplete(pid, code),
    });
    const newBuiltInTools = registry.getAll();

    // Replace built-in tools while keeping MCP tools
    const builtInNames = new Set(newBuiltInTools.map((t) => t.name));
    this.tools = [...newBuiltInTools, ...this.tools.filter((t) => !builtInNames.has(t.name))];
  }

  setMessages(messages: Message[]): void {
    if (this.isRunning) return;
    this.messages = [...messages];
    this.turnCount = 0;
    this.totalTokens = { input: 0, output: 0, total: 0 };
  }

  async prompt(text: string): Promise<void> {
    if (this.isRunning) {
      this.onError('Agent is already processing a request');
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    this.turnCount = 0;

    // Add user message
    const userMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text }],
    };
    this.messages.push(userMessage);

    // Emit status
    this.emitStatus('thinking');

    const runId = crypto.randomUUID();
    this.onRunEvent({ type: 'run_started', runId, timestamp: new Date().toISOString() });

    try {
      await this.runLoop(runId);
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        this.onRunEvent({ type: 'run_aborted', runId, timestamp: new Date().toISOString() });
        this.emitStatus('idle');
      } else {
        this.onRunEvent({
          type: 'run_failed',
          runId,
          error: (error as Error).message,
          timestamp: new Date().toISOString(),
        });
        this.onError((error as Error).message);
        this.emitStatus('error');
      }
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  async continue(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();
    this.emitStatus('thinking');

    const runId = crypto.randomUUID();
    this.onRunEvent({ type: 'run_started', runId, timestamp: new Date().toISOString() });

    try {
      await this.runLoop(runId);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        this.onRunEvent({
          type: 'run_failed',
          runId,
          error: (error as Error).message,
          timestamp: new Date().toISOString(),
        });
        this.onError((error as Error).message);
        this.emitStatus('error');
      } else {
        this.onRunEvent({ type: 'run_aborted', runId, timestamp: new Date().toISOString() });
        this.emitStatus('idle');
      }
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  abort(): void {
    this.abortController?.abort();
    this.isRunning = false;
    this.emitStatus('idle');
  }

  private async runLoop(runId: string): Promise<void> {
    const modelRegistry = createModelRegistry();
    const model = await modelRegistry.getModel(
      this.settings.activeProvider,
      this.settings.activeModel,
    );

    if (!model) {
      this.onError(`Model not found: ${this.settings.activeProvider}/${this.settings.activeModel}`);
      return;
    }

    const skillsLoader = createSkillsLoader(this.workingDir, this.settings.skills);
    const skillsContent = await skillsLoader.loadAll();

    // Load .agents.md (Codex convention): project-level, then user-level
    const agentsMdContent = await loadAgentsMd(this.workingDir);

    // Load auto-generated memories from prior sessions
    const memoryContent = loadMemories(this.workingDir);

    // Compact when enabled and context exceeds the threshold (expressed as
    // a fraction of max context window — roughly 1 message ≈ 1k tokens).
    const compactThresholdMsgs = Math.floor((this.settings.compactThreshold || 0.8) * 100);

    const result = await runAgentLoop({
      model,
      messages: this.messages,
      tools: this.tools,
      settings: this.settings,
      workingDir: this.workingDir,
      skillsContent,
      agentsMdContent,
      memoryContent,
      abortSignal: this.abortController!.signal,
      runId,
      onStream: (event) => {
        this.onStream(event);
      },
      onToolStart: (toolCall) => {
        this.emitStatus('executing');
        this.onToolStart(toolCall);
      },
      onToolEnd: (result) => {
        this.onToolEnd(result);
      },
      onRunEvent: (event) => {
        this.onRunEvent(event);
      },
      initialTurnCount: this.turnCount,
      prepareNextTurn: this.settings.autoCompact
        ? (ctx) => {
            if (ctx.contextMessages.length <= compactThresholdMsgs) return undefined;
            const keepCount = Math.floor(compactThresholdMsgs / 2);
            const systemMsg = ctx.contextMessages.find((m) => m.role === 'system');
            const rest = ctx.contextMessages.filter((m) => m.role !== 'system');
            const trimmed = rest.slice(-keepCount);
            const compacted: Message[] = systemMsg ? [systemMsg, ...trimmed] : trimmed;
            if (compacted.length < ctx.contextMessages.length) {
              console.log(
                `[Agent] Context compacted: ${ctx.contextMessages.length} → ${compacted.length} messages`,
              );
            }
            return { contextMessages: compacted };
          }
        : undefined,
    });

    this.turnCount = result.turnCount;
    this.totalTokens = {
      input: this.totalTokens.input + result.tokenUsage.input,
      output: this.totalTokens.output + result.tokenUsage.output,
      total: this.totalTokens.total + result.tokenUsage.total,
    };

    // Emit run completed
    this.onRunEvent({
      type: 'run_completed',
      runId,
      turnCount: result.turnCount,
      timestamp: new Date().toISOString(),
    });

    // Add assistant message to history
    this.messages.push(result.finalMessage);

    // Emit done
    this.onDone(result.finalMessage);
    this.emitStatus('done');

    // Persist a memory entry so future sessions recall what we did
    this.saveSessionMemory();
  }

  /** Save a summary of the current session to .suncode/memories/. */
  private saveSessionMemory(): void {
    try {
      const lastUserMsg = [...this.messages].reverse().find((m) => m.role === 'user');
      if (!lastUserMsg) return;

      const userRequest =
        typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : lastUserMsg.content
              .filter((b) => b.type === 'text')
              .map((b) => ('text' in b ? b.text : ''))
              .join(' ');

      // Count tools used across all assistant messages
      const toolsUsed: Record<string, number> = {};
      for (const m of this.messages) {
        if (m.role === 'assistant' && m.toolCalls) {
          for (const tc of m.toolCalls) {
            toolsUsed[tc.name] = (toolsUsed[tc.name] || 0) + 1;
          }
        }
      }

      // Slug from the first 40 chars of the user request
      const slug = userRequest
        .slice(0, 40)
        .replace(/[^a-zA-Z0-9一-鿿]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || 'session';

      const entry: MemoryEntry = {
        date: new Date().toISOString().split('T')[0]!,
        slug,
        userRequest: userRequest.slice(0, 200),
        toolsUsed,
        summary: '', // future: LLM-generated summary
      };

      saveMemory(this.workingDir, entry);
    } catch {
      // Best-effort — never let memory failures break the agent
    }
  }

  private emitStatus(state: AgentStatus['state']): void {
    this.onStatus({
      state,
      turnCount: this.turnCount,
      tokenUsage: { ...this.totalTokens },
      modelName: `${this.settings.activeProvider}/${this.settings.activeModel}`,
    });
  }

  getMessages(): Message[] {
    return this.messages;
  }

  getWorkingDir(): string {
    return this.workingDir;
  }
}

/**
 * Load .agents.md files following the Codex convention.
 * Reads project-level (.agents.md in project root) and user-level (~/.agents.md).
 * Both are combined into a single instructions block for the system prompt.
 */
async function loadAgentsMd(workingDir: string): Promise<string> {
  const parts: string[] = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || '~';

  // Project-level .agents.md (also try AGENTS.md as fallback)
  for (const name of ['.agents.md', 'AGENTS.md']) {
    const projectPath = join(workingDir, name);
    if (existsSync(projectPath)) {
      try {
        const content = await readFile(projectPath, 'utf-8');
        if (content.trim()) {
          parts.push(content.trim());
        }
        break; // Only load the first one found
      } catch {
        // Skip unreadable files
      }
    }
  }

  // User-level ~/.agents.md
  const userPath = join(homeDir, '.agents.md');
  if (existsSync(userPath)) {
    try {
      const content = await readFile(userPath, 'utf-8');
      if (content.trim()) {
        parts.push(content.trim());
      }
    } catch {
      // Skip unreadable files
    }
  }

  return parts.join('\n\n');
}
