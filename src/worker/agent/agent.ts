import type {
  AppSettings,
  StreamEvent,
  AgentStatus,
  ToolResult,
  Message,
  ToolCallContent,
} from '@shared/types';
import { runAgentLoop } from './agent-loop';
import type { Tool } from '../tools/types';
import { createToolRegistry } from '../tools/registry';
import { createMcpManager } from '../mcp/manager';
import { createSkillsLoader } from './skills';
import { createModelRegistry } from '../models/registry';

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
  private onToolStart: (toolCallId: string, toolName: string) => void;
  private onToolEnd: (result: ToolResult) => void;
  private onDone: (message: Message) => void;
  private onError: (message: string) => void;

  constructor(
    workingDir: string,
    settings: AppSettings,
    onStream: (event: StreamEvent) => void,
    onStatus: (status: AgentStatus) => void,
    onToolStart: (toolCallId: string, toolName: string) => void,
    onToolEnd: (result: ToolResult) => void,
    onDone: (message: Message) => void,
    onError: (message: string) => void,
  ) {
    this.workingDir = workingDir;
    this.settings = settings;
    this.onStream = onStream;
    this.onStatus = onStatus;
    this.onToolStart = onToolStart;
    this.onToolEnd = onToolEnd;
    this.onDone = onDone;
    this.onError = onError;

    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      // Load built-in tools
      const registry = createToolRegistry(this.workingDir);
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

    try {
      await this.runLoop();
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        // User aborted
        this.emitStatus('idle');
      } else {
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

    try {
      await this.runLoop();
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        this.onError((error as Error).message);
        this.emitStatus('error');
      } else {
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

  private async runLoop(): Promise<void> {
    const modelRegistry = createModelRegistry();
    const model = await modelRegistry.getModel(this.settings.activeProvider, this.settings.activeModel);

    if (!model) {
      this.onError(
        `Model not found: ${this.settings.activeProvider}/${this.settings.activeModel}`,
      );
      return;
    }

    const skillsLoader = createSkillsLoader(this.workingDir, this.settings.skills);
    const skillsContent = await skillsLoader.loadAll();

    const result = await runAgentLoop({
      model,
      messages: this.messages,
      tools: this.tools,
      settings: this.settings,
      workingDir: this.workingDir,
      skillsContent,
      abortSignal: this.abortController!.signal,
      onStream: (event) => {
        this.onStream(event);
      },
      onToolStart: (id, name) => {
        this.emitStatus('executing');
        this.onToolStart(id, name);
      },
      onToolEnd: (result) => {
        this.onToolEnd(result);
      },
      initialTurnCount: this.turnCount,
    });

    this.turnCount = result.turnCount;
    this.totalTokens = {
      input: this.totalTokens.input + result.tokenUsage.input,
      output: this.totalTokens.output + result.tokenUsage.output,
      total: this.totalTokens.total + result.tokenUsage.total,
    };

    // Add assistant message to history
    this.messages.push(result.finalMessage);

    // Emit done
    this.onDone(result.finalMessage);
    this.emitStatus('done');
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
