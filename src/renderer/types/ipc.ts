/**
 * Type declarations for the window.suncode API.
 * All event callbacks receive a wrapper with sessionId for multi-session routing.
 */
import type {
  AgentStatus,
  AppSettings,
  BackgroundProcess,
  FileNode,
  GitBranch,
  GitCheckoutResult,
  GitInfo,
  GoalEvent,
  Message,
  RunEvent,
  SessionMeta,
  StreamEvent,
  TokenUsageSummary,
  ToolCallContent,
  ToolResult,
  UiLanguage,
  UpdateStatus,
} from '@shared/types';

/** Wrapper types for IPC events that carry sessionId for multi-session routing. */
export interface SessionStreamEvent {
  sessionId: string;
  event: StreamEvent;
}
export interface SessionStatusEvent {
  sessionId: string;
  status: AgentStatus;
}
export interface SessionErrorEvent {
  sessionId: string;
  message: string;
}
export interface SessionDoneEvent {
  sessionId: string;
  message: Message;
}
export interface SessionToolStartEvent {
  sessionId: string;
  toolCall: ToolCallContent;
}
export interface SessionToolEndEvent {
  sessionId: string;
  toolResult: ToolResult;
}
export interface SessionToolProgressEvent {
  sessionId: string;
  toolCallId: string;
  output: string;
}
export interface SessionBgProcessStartedEvent {
  sessionId: string;
  process: BackgroundProcess;
}
export interface SessionBgProcessCompletedEvent {
  sessionId: string;
  pid: number;
  exitCode: number;
}
export interface SessionBgProcessPortsVerifiedEvent {
  sessionId: string;
  pid: number;
  ports: number[];
}
export interface SessionRunEvent {
  sessionId: string;
  event: RunEvent;
}
export interface SessionSubagentStartEvent {
  sessionId: string;
  execution: Record<string, unknown>;
}
export interface SessionSubagentEndEvent {
  sessionId: string;
  id: string;
  result: Record<string, unknown>;
}
export interface SessionSubagentProgressEvent {
  sessionId: string;
  executionId: string;
  agent: string;
  delta: Record<string, unknown>;
}
export interface SessionGoalEvent {
  sessionId: string;
  event: GoalEvent;
}
export interface SessionConfirmRequestEvent {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  description: string;
}

declare global {
  interface Window {
    suncode: {
      // Agent
      prompt(text: string, uiLanguage?: UiLanguage): void;
      abort(): void;
      injectGuidance(text: string, uiLanguage?: UiLanguage): void;
      stop(): void;
      continue(): void;
      onStreamEvent(callback: (data: SessionStreamEvent) => void): () => void;
      onStatusChange(callback: (data: SessionStatusEvent) => void): () => void;
      onError(callback: (data: SessionErrorEvent) => void): () => void;
      onDone(callback: (data: SessionDoneEvent) => void): () => void;
      onToolStart(callback: (data: SessionToolStartEvent) => void): () => void;
      onToolEnd(callback: (data: SessionToolEndEvent) => void): () => void;
      onToolProgress(callback: (data: SessionToolProgressEvent) => void): () => void;

      // File system
      getFileTree(rootPath?: string): Promise<FileNode[]>;
      readFile(filePath: string, offset?: number, limit?: number): Promise<string>;
      selectDirectory(): Promise<string | null>;
      watchFile(filePath: string, callback: (content: string) => void): () => void;

      // Session
      getSessions(): Promise<SessionMeta[]>;
      createSession(name: string, workingDirectory?: string): Promise<SessionMeta>;
      loadSession(id: string, maxMessages?: number): Promise<Message[]>;
      saveMessage(message: Message, targetSessionId?: string): Promise<void>;
      exportSession(id: string): Promise<string>;
      deleteSession(id: string): Promise<{ remaining: SessionMeta[]; wasActive: boolean }>;
      deleteSessions(ids: string[]): Promise<{ remaining: SessionMeta[]; wasActive: boolean }>;
      clearSessionMessages(): void;

      // Settings
      getSettings(): Promise<AppSettings>;
      updateSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
      onSettingsChanged(callback: (settings: AppSettings) => void): () => void;
      showTaskCompleteNotification(title: string, body: string, sessionId?: string): void;
      onTaskNotificationClick(callback: (data: { sessionId: string }) => void): () => void;

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
      getAppVersion(): Promise<string>;
      getLogPath(): Promise<string>;
      getSessionFilePath(sessionId: string): Promise<string>;
      openPath(targetPath: string): Promise<void>;
      showItemInFolder(fullPath: string): void;
      getTokenUsage(): Promise<TokenUsageSummary>;
      getSkills(): Promise<Array<{ name: string; path: string; description: string }>>;

      // Git
      getGitInfo(workingDir: string): Promise<GitInfo>;
      listGitBranches(workingDir: string): Promise<GitBranch[]>;
      checkoutGitBranch(workingDir: string, branch: string): Promise<GitCheckoutResult>;
      getStagedDiff(workingDir: string): Promise<string>;
      gitCommit(
        workingDir: string,
        message: string,
      ): Promise<{ success: boolean; output?: string; error?: string }>;
      generateCommitMessage(workingDir: string): Promise<{ message: string }>;

      // Background Processes
      onBgProcessStarted(callback: (data: SessionBgProcessStartedEvent) => void): () => void;
      onBgProcessCompleted(callback: (data: SessionBgProcessCompletedEvent) => void): () => void;
      onBgProcessPortsVerified(
        callback: (data: SessionBgProcessPortsVerifiedEvent) => void,
      ): () => void;
      killBgProcess(pid: number): void;

      // Window
      setTitleBarOverlayText(text: string): void;
      setTheme(theme: AppSettings['theme']): Promise<'light' | 'dark'>;
      setChromeColors(colors: { background: string; foreground: string } | null): void;
      // Subagent
      onSubagentProgress(callback: (data: SessionSubagentProgressEvent) => void): () => void;
      // Goal
      onGoalEvent(callback: (data: SessionGoalEvent) => void): () => void;

      // Permission confirmation
      onConfirmRequest(callback: (data: SessionConfirmRequestEvent) => void): () => void;
      respondConfirm(toolCallId: string, confirmed: boolean, sessionId?: string): void;

      // Session updates (e.g. AI-generated title)
      onSessionUpdated(callback: (meta: SessionMeta) => void): () => void;

      // Run lifecycle events (for call trace panel)
      onRunEvent(callback: (data: SessionRunEvent) => void): () => void;

      // Auto Update
      checkForUpdates(): void;
      downloadUpdate(): void;
      installUpdate(): void;
      skipVersion(version: string): void;
      getUpdateStatus(): Promise<UpdateStatus>;
      onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
    };
  }
}
