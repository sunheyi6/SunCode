import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  BackgroundProcess,
  FileNode,
  GitInfo,
  GoalEvent,
  RunEvent,
  StreamEvent,
  AgentStatus,
  Message,
  ToolCallContent,
  ToolResult,
  SessionMeta,
  TokenUsageSummary,
  UpdateStatus,
} from '@shared/types';

/**
 * SunCode API exposed to the renderer process via contextBridge.
 * This is the only interface the renderer can use to communicate
 * with the main process and agent worker.
 */
const suncodeAPI = {
  // ===== Agent Control =====

  /** Send a prompt to the agent */
  prompt(text: string): void {
    ipcRenderer.send('agent:prompt', text);
  },

  /** Abort the current agent run */
  abort(): void {
    ipcRenderer.send('agent:abort');
  },

  /** Continue the agent (after tool confirmation, etc.) */
  continue(): void {
    ipcRenderer.send('agent:continue');
  },

  /** Listen for stream events from the agent */
  onStreamEvent(callback: (data: { sessionId: string; event: StreamEvent }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; event: StreamEvent }): void =>
      callback(data);
    ipcRenderer.on('agent:stream', handler);
    return () => ipcRenderer.removeListener('agent:stream', handler);
  },

  /** Listen for agent status changes */
  onStatusChange(callback: (data: { sessionId: string; status: AgentStatus }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; status: AgentStatus }): void =>
      callback(data);
    ipcRenderer.on('agent:status', handler);
    return () => ipcRenderer.removeListener('agent:status', handler);
  },

  /** Listen for agent errors */
  onError(callback: (data: { sessionId: string; message: string }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; message: string }): void =>
      callback(data);
    ipcRenderer.on('agent:error', handler);
    return () => ipcRenderer.removeListener('agent:error', handler);
  },

  /** Listen for agent done event */
  onDone(callback: (data: { sessionId: string; message: Message }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; message: Message }): void =>
      callback(data);
    ipcRenderer.on('agent:done', handler);
    return () => ipcRenderer.removeListener('agent:done', handler);
  },

  /** Listen for tool execution start */
  onToolStart(callback: (data: { sessionId: string; toolCall: ToolCallContent }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; toolCall: ToolCallContent }): void =>
      callback(data);
    ipcRenderer.on('agent:tool-start', handler);
    return () => ipcRenderer.removeListener('agent:tool-start', handler);
  },

  /** Listen for tool execution end */
  /** Listen for tool progress (real-time output streaming) */
  onToolProgress(callback: (data: { sessionId: string; toolCallId: string; output: string }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; toolCallId: string; output: string }): void =>
      callback(data);
    ipcRenderer.on('agent:tool-progress', handler);
    return () => ipcRenderer.removeListener('agent:tool-progress', handler);
  },

  onToolEnd(callback: (data: { sessionId: string; toolResult: ToolResult }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; toolResult: ToolResult }): void =>
      callback(data);
    ipcRenderer.on('agent:tool-end', handler);
    return () => ipcRenderer.removeListener('agent:tool-end', handler);
  },

  // ===== File Operations =====

  /** Get the file tree for a directory */
  async getFileTree(rootPath?: string): Promise<FileNode[]> {
    return ipcRenderer.invoke('fs:getFileTree', rootPath);
  },

  /** Read file contents */
  async readFile(filePath: string, offset?: number, limit?: number): Promise<string> {
    return ipcRenderer.invoke('fs:readFile', filePath, offset, limit);
  },

  /** Select a directory via native dialog */
  async selectDirectory(): Promise<string | null> {
    return ipcRenderer.invoke('fs:selectDirectory');
  },

  /** Watch a file for changes */
  watchFile(filePath: string, callback: (content: string) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, content: string): void => callback(content);
    ipcRenderer.on(`fs:fileChanged:${filePath}`, handler);
    ipcRenderer.send('fs:watchFile', filePath);
    return () => {
      ipcRenderer.removeListener(`fs:fileChanged:${filePath}`, handler);
      ipcRenderer.send('fs:unwatchFile', filePath);
    };
  },

  // ===== Session Management =====

  /** List all saved sessions */
  async getSessions(): Promise<SessionMeta[]> {
    return ipcRenderer.invoke('session:list');
  },

  /** Create a new session */
  async createSession(name: string, workingDirectory?: string): Promise<SessionMeta> {
    return ipcRenderer.invoke('session:create', name, workingDirectory);
  },

  /** Load session messages */
  async loadSession(id: string): Promise<Message[]> {
    return ipcRenderer.invoke('session:load', id);
  },

  /** Save a message to the current session */
  async saveMessage(message: Message, targetSessionId?: string): Promise<void> {
    return ipcRenderer.invoke('session:saveMessage', message, targetSessionId);
  },

  /** Export session to HTML */
  async exportSession(id: string): Promise<string> {
    return ipcRenderer.invoke('session:export', id);
  },

  /** Delete a session */
  async deleteSession(id: string): Promise<{ remaining: SessionMeta[]; wasActive: boolean }> {
    return ipcRenderer.invoke('session:delete', id);
  },

  /** Delete multiple sessions */
  async deleteSessions(ids: string[]): Promise<{ remaining: SessionMeta[]; wasActive: boolean }> {
    return ipcRenderer.invoke('session:deleteMany', ids);
  },

  /** Clear messages in the current session (stay in same session). */
  clearSessionMessages(): void {
    ipcRenderer.send('session:clearMessages');
  },

  /** Listen for sub-agent progress updates */
  onSubagentProgress(
    callback: (data: { sessionId: string; executionId: string; agent: string; delta: Record<string, unknown> }) => void,
  ): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { sessionId: string; executionId: string; agent: string; delta: Record<string, unknown> },
    ): void => callback(data);
    ipcRenderer.on('agent:subagent-progress', handler);
    return () => ipcRenderer.removeListener('agent:subagent-progress', handler);
  },

  /** Get token usage statistics */
  async getTokenUsage(): Promise<TokenUsageSummary> {
    return ipcRenderer.invoke('stats:getTokenUsage');
  },

  // ===== Settings =====

  /** Get current settings */
  async getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke('settings:get');
  },

  /** Update settings */
  async updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    return ipcRenderer.invoke('settings:update', partial);
  },

  /** Listen for settings changes */
  onSettingsChanged(callback: (settings: AppSettings) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, settings: AppSettings): void =>
      callback(settings);
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.removeListener('settings:changed', handler);
  },

  // ===== Model Discovery =====

  /** Get all available AI providers */
  async getProviders(): Promise<string[]> {
    return ipcRenderer.invoke('models:getProviders');
  },

  /** Get all models for a specific provider */
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
    return ipcRenderer.invoke('models:getModels', provider);
  },

  /** Get recommended coding models */
  async getRecommendedModels(): Promise<Array<{ provider: string; model: string; label: string }>> {
    return ipcRenderer.invoke('models:getRecommended');
  },

  // ===== API Keys =====

  /** Set API key for a provider */
  async setApiKey(provider: string, key: string): Promise<boolean> {
    return ipcRenderer.invoke('settings:setApiKey', provider, key);
  },

  // ===== Dialog =====

  /** Show a confirmation dialog */
  async confirm(title: string, message: string): Promise<boolean> {
    return ipcRenderer.invoke('dialog:confirm', title, message);
  },

  /** Update the native title bar overlay text (shows folder name in title bar) */
  setTitleBarOverlayText(text: string): void {
    ipcRenderer.send('window:setTitleBarOverlayText', text);
  },
  async getWorkingDir(): Promise<string> {
    return ipcRenderer.invoke('app:getWorkingDir');
  },

  /** Get git info for a directory */
  async getGitInfo(workingDir: string): Promise<GitInfo> {
    return ipcRenderer.invoke('git:getInfo', workingDir);
  },

  /** Get staged diff for commit message generation */
  async getStagedDiff(workingDir: string): Promise<string> {
    return ipcRenderer.invoke('git:getStagedDiff', workingDir);
  },

  /** Execute git commit */
  async gitCommit(
    workingDir: string,
    message: string,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return ipcRenderer.invoke('git:commit', workingDir, message);
  },

  /** Generate commit message via AI */
  async generateCommitMessage(workingDir: string): Promise<{ message: string }> {
    return ipcRenderer.invoke('git:generateCommitMessage', workingDir);
  },

  // ===== Background Processes =====

  /** Listen for background process started events */
  onBgProcessStarted(callback: (data: { sessionId: string; process: BackgroundProcess }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; process: BackgroundProcess }): void =>
      callback(data);
    ipcRenderer.on('agent:bg-process-started', handler);
    return () => ipcRenderer.removeListener('agent:bg-process-started', handler);
  },

  /** Listen for background process completed events */
  onBgProcessCompleted(callback: (data: { sessionId: string; pid: number; exitCode: number }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; pid: number; exitCode: number }): void =>
      callback(data);
    ipcRenderer.on('agent:bg-process-completed', handler);
    return () => ipcRenderer.removeListener('agent:bg-process-completed', handler);
  },

  /** Listen for background process ports verified events */
  onBgProcessPortsVerified(callback: (data: { sessionId: string; pid: number; ports: number[] }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; pid: number; ports: number[] }): void =>
      callback(data);
    ipcRenderer.on('agent:bg-process-ports-verified', handler);
    return () => ipcRenderer.removeListener('agent:bg-process-ports-verified', handler);
  },

  /** Kill a running background process by PID */
  killBgProcess(pid: number): void {
    ipcRenderer.send('agent:kill-bg-process', pid);
  },

  /** Listen for goal lifecycle events */
  onGoalEvent(callback: (data: { sessionId: string; event: GoalEvent }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; event: GoalEvent }): void =>
      callback(data);
    ipcRenderer.on('agent:goal-event', handler);
    return () => ipcRenderer.removeListener('agent:goal-event', handler);
  },

  /** Listen for tool confirmation requests (confirm_changes mode) */
  onConfirmRequest(
    callback: (data: { sessionId: string; toolCallId: string; toolName: string; description: string }) => void,
  ): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { sessionId: string; toolCallId: string; toolName: string; description: string },
    ): void => callback(data);
    ipcRenderer.on('agent:confirm-request', handler);
    return () => ipcRenderer.removeListener('agent:confirm-request', handler);
  },

  /** Respond to a tool confirmation request */
  respondConfirm(toolCallId: string, confirmed: boolean, sessionId?: string): void {
    ipcRenderer.send('agent:confirm-response', toolCallId, confirmed, sessionId);
  },

  /** Get the app version */
  async getAppVersion(): Promise<string> {
    return ipcRenderer.invoke('app:getVersion');
  },

  /** Get the absolute path to the current app log file */
  async getLogPath(): Promise<string> {
    return ipcRenderer.invoke('app:getLogPath');
  },

  /** Open a file or folder in the system file explorer */
  async openPath(targetPath: string): Promise<void> {
    return ipcRenderer.invoke('shell:openPath', targetPath);
  },

  /** Show a file in the system file explorer (opens folder and selects file) */
  showItemInFolder(fullPath: string): void {
    ipcRenderer.invoke('shell:showItemInFolder', fullPath);
  },

  /** Listen for run lifecycle events (for call trace panel). */
  onRunEvent(callback: (data: { sessionId: string; event: RunEvent }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; event: RunEvent }): void =>
      callback(data);
    ipcRenderer.on('agent:run-event', handler);
    return () => ipcRenderer.removeListener('agent:run-event', handler);
  },

  /** Listen for session metadata updates (e.g. AI-generated title) */
  onSessionUpdated(callback: (meta: SessionMeta) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, meta: SessionMeta): void => callback(meta);
    ipcRenderer.on('session:updated', handler);
    return () => ipcRenderer.removeListener('session:updated', handler);
  },

  // ===== Auto Update =====

  /** Check for updates manually */
  checkForUpdates(): void {
    ipcRenderer.send('updater:check');
  },

  /** Start downloading the available update */
  downloadUpdate(): void {
    ipcRenderer.send('updater:download');
  },

  /** Install the downloaded update (quit and restart) */
  installUpdate(): void {
    ipcRenderer.send('updater:install');
  },

  /** Skip a specific version (don't notify again for this version) */
  skipVersion(version: string): void {
    ipcRenderer.send('updater:skip-version', version);
  },

  /** Get the current update status */
  async getUpdateStatus(): Promise<UpdateStatus> {
    return ipcRenderer.invoke('updater:getStatus');
  },

  /** Listen for update status changes */
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void =>
      callback(status);
    ipcRenderer.on('updater:status', handler);
    return () => ipcRenderer.removeListener('updater:status', handler);
  },
};

contextBridge.exposeInMainWorld('suncode', suncodeAPI);

export type SunCodeAPI = typeof suncodeAPI;
