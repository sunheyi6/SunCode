/**
 * Type-safe wrapper around the window.suncode API.
 * Provides a clean interface for Vue components to interact with the agent.
 */
import type {
  BackgroundProcess,
  GitInfo,
  GoalEvent,
  StreamEvent,
  AgentStatus,
  Message,
  ToolCallContent,
  ToolResult,
  FileNode,
  AppSettings,
  SessionMeta,
  TokenUsageSummary,
} from '@shared/types';

const api = (): NonNullable<Window['suncode']> => {
  if (!window.suncode) {
    throw new Error('window.suncode API not available — ensure preload script has loaded');
  }
  return window.suncode;
};

export const bridge = {
  // ===== Agent =====
  prompt(text: string): void {
    api().prompt(text);
  },

  abort(): void {
    api().abort();
  },

  continue(): void {
    api().continue();
  },

  onStreamEvent(callback: (event: StreamEvent) => void): () => void {
    return api().onStreamEvent(callback);
  },

  onStatusChange(callback: (status: AgentStatus) => void): () => void {
    return api().onStatusChange(callback);
  },

  onError(callback: (message: string) => void): () => void {
    return api().onError(callback);
  },

  onDone(callback: (message: Message) => void): () => void {
    return api().onDone(callback);
  },

  onToolStart(callback: (toolCall: ToolCallContent) => void): () => void {
    return api().onToolStart(callback);
  },

  onToolEnd(callback: (result: ToolResult) => void): () => void {
    return api().onToolEnd(callback);
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

  async loadSession(id: string): Promise<Message[]> {
    return api().loadSession(id);
  },

  async saveMessage(message: Message): Promise<void> {
    return api().saveMessage(message);
  },

  async deleteSession(id: string): Promise<{ remaining: SessionMeta[]; wasActive: boolean }> {
    return api().deleteSession(id);
  },

  async deleteSessions(ids: string[]): Promise<{ remaining: SessionMeta[]; wasActive: boolean }> {
    return api().deleteSessions(ids);
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

  async getTokenUsage(): Promise<TokenUsageSummary> {
    return api().getTokenUsage();
  },

  // ===== Git =====
  async getGitInfo(workingDir: string): Promise<GitInfo> {
    return api().getGitInfo(workingDir);
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
  onBgProcessStarted(callback: (proc: BackgroundProcess) => void): () => void {
    return api().onBgProcessStarted(callback);
  },

  onBgProcessCompleted(callback: (pid: number, exitCode: number) => void): () => void {
    return api().onBgProcessCompleted(callback);
  },

  onGoalEvent(callback: (event: GoalEvent) => void): () => void {
    return api().onGoalEvent(callback);
  },

  // ===== Subagent =====
  onSubagentProgress(
    callback: (executionId: string, agent: string, delta: Record<string, unknown>) => void,
  ): () => void {
    return api().onSubagentProgress(callback);
  },

  // ===== Permission Confirmation =====
  onConfirmRequest(
    callback: (request: { toolCallId: string; toolName: string; description: string }) => void,
  ): () => void {
    return api().onConfirmRequest(callback);
  },

  respondConfirm(toolCallId: string, confirmed: boolean): void {
    api().respondConfirm(toolCallId, confirmed);
  },

  // ===== Session Updates =====
  onSessionUpdated(callback: (meta: SessionMeta) => void): () => void {
    return api().onSessionUpdated(callback);
  },

  // ===== Window =====
  setTitleBarOverlayText(text: string): void {
    api().setTitleBarOverlayText(text);
  },
};
