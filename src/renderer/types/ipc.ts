/**
 * Type declarations for the window.suncode API.
 */
import type {
  BackgroundProcess,
  GitInfo,
  StreamEvent,
  AgentStatus,
  Message,
  ToolCallContent,
  ToolResult,
  FileNode,
  AppSettings,
  SessionMeta,
} from '@shared/types';

declare global {
  interface Window {
    suncode: {
      // Agent
      prompt(text: string): void;
      abort(): void;
      continue(): void;
      onStreamEvent(callback: (event: StreamEvent) => void): () => void;
      onStatusChange(callback: (status: AgentStatus) => void): () => void;
      onError(callback: (message: string) => void): () => void;
      onDone(callback: (message: Message) => void): () => void;
      onToolStart(callback: (toolCall: ToolCallContent) => void): () => void;
      onToolEnd(callback: (result: ToolResult) => void): () => void;

      // File system
      getFileTree(rootPath?: string): Promise<FileNode[]>;
      readFile(filePath: string, offset?: number, limit?: number): Promise<string>;
      selectDirectory(): Promise<string | null>;
      watchFile(filePath: string, callback: (content: string) => void): () => void;

      // Session
      getSessions(): Promise<SessionMeta[]>;
      createSession(name: string, workingDirectory?: string): Promise<SessionMeta>;
      loadSession(id: string): Promise<Message[]>;
      saveMessage(message: Message): Promise<void>;
      exportSession(id: string): Promise<string>;

      // Settings
      getSettings(): Promise<AppSettings>;
      updateSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
      onSettingsChanged(callback: (settings: AppSettings) => void): () => void;

      // Model Discovery
      getProviders(): Promise<string[]>;
      getModels(provider: string): Promise<
        Array<{
          id: string;
          name: string;
          provider: string;
          contextWindow: number;
          maxTokens: number;
          supportsReasoning: boolean;
          supportsImages: boolean;
        }>
      >;
      getRecommendedModels(): Promise<Array<{ provider: string; model: string; label: string }>>;

      // API Keys
      setApiKey(provider: string, key: string): Promise<boolean>;

      // Dialog
      confirm(title: string, message: string): Promise<boolean>;

      // App
      getWorkingDir(): Promise<string>;

      // Git
      getGitInfo(workingDir: string): Promise<GitInfo>;
      getStagedDiff(workingDir: string): Promise<string>;
      gitCommit(workingDir: string, message: string): Promise<{ success: boolean; output?: string; error?: string }>;
      generateCommitMessage(workingDir: string): Promise<{ message: string }>;

      // Background Processes
      onBgProcessStarted(callback: (proc: BackgroundProcess) => void): () => void;
      onBgProcessCompleted(callback: (pid: number, exitCode: number) => void): () => void;
    };
  }
}

export {};
