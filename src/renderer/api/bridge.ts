/**
 * Type-safe wrapper around the window.suncode API.
 * Provides a clean interface for Vue components to interact with the agent.
 */
import type {
  AppSettings,
  FileNode,
  GitBranch,
  GitCheckoutResult,
  GitInfo,
  Message,
  SessionMeta,
  TokenUsageSummary,
  UiLanguage,
  UpdateStatus,
} from '@shared/types';
import type {
  SessionBgProcessCompletedEvent,
  SessionBgProcessPortsVerifiedEvent,
  SessionBgProcessStartedEvent,
  SessionConfirmRequestEvent,
  SessionDoneEvent,
  SessionErrorEvent,
  SessionGoalEvent,
  SessionRunEvent,
  SessionStatusEvent,
  SessionStreamEvent,
  SessionSubagentProgressEvent,
  SessionToolEndEvent,
  SessionToolProgressEvent,
  SessionToolStartEvent,
} from '../types/ipc';

const api = (): NonNullable<Window['suncode']> => {
  if (!window.suncode) {
    throw new Error('window.suncode API not available — ensure preload script has loaded');
  }
  return window.suncode;
};

export const bridge = {
  // ===== Agent =====
  prompt(text: string, uiLanguage?: UiLanguage): void {
    api().prompt(text, uiLanguage);
  },

  abort(): void {
    api().abort();
  },

  stop(): void {
    api().stop();
  },

  continue(): void {
    api().continue();
  },

  onStreamEvent(callback: (data: SessionStreamEvent) => void): () => void {
    return api().onStreamEvent(callback);
  },

  onStatusChange(callback: (data: SessionStatusEvent) => void): () => void {
    return api().onStatusChange(callback);
  },

  onError(callback: (data: SessionErrorEvent) => void): () => void {
    return api().onError(callback);
  },

  onDone(callback: (data: SessionDoneEvent) => void): () => void {
    return api().onDone(callback);
  },

  onToolStart(callback: (data: SessionToolStartEvent) => void): () => void {
    return api().onToolStart(callback);
  },

  onToolEnd(callback: (data: SessionToolEndEvent) => void): () => void {
    return api().onToolEnd(callback);
  },

  onToolProgress(callback: (data: SessionToolProgressEvent) => void): () => void {
    return api().onToolProgress(callback);
  },

  // ===== Files =====
  async getFileTree(rootPath?: string): Promise<FileNode[]> {
    return api().getFileTree(rootPath);
  },

  async readFile(filePath: string, offset?: number, limit?: number): Promise<string> {
    return api().readFile(filePath, offset, limit);
  },

  async selectDirectory(): Promise<string | null> {
    return api().selectDirectory();
  },

  // ===== Session =====
  async getSessions(): Promise<SessionMeta[]> {
    return api().getSessions();
  },

  async createSession(name: string, workingDirectory?: string): Promise<SessionMeta> {
    return api().createSession(name, workingDirectory);
  },

  async loadSession(id: string, maxMessages?: number): Promise<Message[]> {
    return api().loadSession(id, maxMessages);
  },

  async saveMessage(message: Message, targetSessionId?: string): Promise<void> {
    return api().saveMessage(message, targetSessionId);
  },

  async deleteSession(id: string): Promise<{ remaining: SessionMeta[]; wasActive: boolean }> {
    return api().deleteSession(id);
  },

  async deleteSessions(ids: string[]): Promise<{ remaining: SessionMeta[]; wasActive: boolean }> {
    return api().deleteSessions(ids);
  },

  /** Clear all messages in the current session without changing sessions. */
  clearSessionMessages(): void {
    api().clearSessionMessages();
  },

  // ===== Settings =====
  async getSettings(): Promise<AppSettings> {
    return api().getSettings();
  },

  async updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    return api().updateSettings(partial);
  },

  onSettingsChanged(callback: (settings: AppSettings) => void): () => void {
    return api().onSettingsChanged(callback);
  },

  /** Show native task completion notification */
  showTaskCompleteNotification(title: string, body: string): void {
    api().showTaskCompleteNotification(title, body);
  },

  // ===== Model Discovery =====
  async getProviders(): Promise<string[]> {
    return api().getProviders();
  },

  async getModels(provider: string): Promise<
    Array<{
      id: string;
      name: string;
      provider: string;
      contextWindow: number;
      maxTokens: number;
      supportsReasoning: boolean;
      supportsImages: boolean;
    }>
  > {
    return api().getModels(provider);
  },

  async getRecommendedModels(): Promise<Array<{ provider: string; model: string; label: string }>> {
    return api().getRecommendedModels();
  },

  // ===== API Keys =====
  async setApiKey(provider: string, key: string): Promise<boolean> {
    return api().setApiKey(provider, key);
  },

  // ===== Dialog =====
  async confirm(title: string, message: string): Promise<boolean> {
    return api().confirm(title, message);
  },

  // ===== App =====
  async getWorkingDir(): Promise<string> {
    return api().getWorkingDir();
  },

  async getAppVersion(): Promise<string> {
    return api().getAppVersion();
  },

  async getLogPath(): Promise<string> {
    return api().getLogPath();
  },

  async openPath(targetPath: string): Promise<void> {
    return api().openPath(targetPath);
  },

  showItemInFolder(fullPath: string): void {
    api().showItemInFolder(fullPath);
  },

  async getTokenUsage(): Promise<TokenUsageSummary> {
    return api().getTokenUsage();
  },

  // ===== Git =====
  async getGitInfo(workingDir: string): Promise<GitInfo> {
    return api().getGitInfo(workingDir);
  },

  async listGitBranches(workingDir: string): Promise<GitBranch[]> {
    return api().listGitBranches(workingDir);
  },

  async checkoutGitBranch(workingDir: string, branch: string): Promise<GitCheckoutResult> {
    return api().checkoutGitBranch(workingDir, branch);
  },

  async getStagedDiff(workingDir: string): Promise<string> {
    return api().getStagedDiff(workingDir);
  },

  async gitCommit(
    workingDir: string,
    message: string,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return api().gitCommit(workingDir, message);
  },

  async generateCommitMessage(workingDir: string): Promise<{ message: string }> {
    return api().generateCommitMessage(workingDir);
  },

  // ===== Background Processes =====
  onBgProcessStarted(callback: (data: SessionBgProcessStartedEvent) => void): () => void {
    return api().onBgProcessStarted(callback);
  },

  onBgProcessCompleted(callback: (data: SessionBgProcessCompletedEvent) => void): () => void {
    return api().onBgProcessCompleted(callback);
  },

  onBgProcessPortsVerified(
    callback: (data: SessionBgProcessPortsVerifiedEvent) => void,
  ): () => void {
    return api().onBgProcessPortsVerified(callback);
  },

  killBgProcess(pid: number): void {
    api().killBgProcess(pid);
  },

  onGoalEvent(callback: (data: SessionGoalEvent) => void): () => void {
    return api().onGoalEvent(callback);
  },

  // ===== Subagent =====
  onSubagentProgress(callback: (data: SessionSubagentProgressEvent) => void): () => void {
    return api().onSubagentProgress(callback);
  },

  // ===== Permission Confirmation =====
  onConfirmRequest(callback: (data: SessionConfirmRequestEvent) => void): () => void {
    return api().onConfirmRequest(callback);
  },

  onRunEvent(callback: (data: SessionRunEvent) => void): () => void {
    return api().onRunEvent(callback);
  },

  respondConfirm(toolCallId: string, confirmed: boolean, sessionId?: string): void {
    api().respondConfirm(toolCallId, confirmed, sessionId);
  },

  // ===== Session Updates =====
  onSessionUpdated(callback: (meta: SessionMeta) => void): () => void {
    return api().onSessionUpdated(callback);
  },

  // ===== Window =====
  setTitleBarOverlayText(text: string): void {
    api().setTitleBarOverlayText(text);
  },

  setTheme(theme: string): void {
    api().setTheme(theme);
  },

  // ===== Auto Update =====
  checkForUpdates(): void {
    api().checkForUpdates();
  },

  downloadUpdate(): void {
    api().downloadUpdate();
  },

  installUpdate(): void {
    api().installUpdate();
  },

  skipVersion(version: string): void {
    api().skipVersion(version);
  },

  async getUpdateStatus(): Promise<UpdateStatus> {
    return api().getUpdateStatus();
  },

  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void {
    return api().onUpdateStatus(callback);
  },
};
