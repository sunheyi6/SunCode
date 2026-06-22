import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  FileNode,
  StreamEvent,
  AgentStatus,
  Message,
  ToolResult,
  SessionMeta,
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
  onStreamEvent(callback: (event: StreamEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, event: StreamEvent): void =>
      callback(event);
    ipcRenderer.on('agent:stream', handler);
    return () => ipcRenderer.removeListener('agent:stream', handler);
  },

  /** Listen for agent status changes */
  onStatusChange(callback: (status: AgentStatus) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, status: AgentStatus): void =>
      callback(status);
    ipcRenderer.on('agent:status', handler);
    return () => ipcRenderer.removeListener('agent:status', handler);
  },

  /** Listen for agent errors */
  onError(callback: (message: string) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, message: string): void =>
      callback(message);
    ipcRenderer.on('agent:error', handler);
    return () => ipcRenderer.removeListener('agent:error', handler);
  },

  /** Listen for agent done event */
  onDone(callback: (message: Message) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, message: Message): void =>
      callback(message);
    ipcRenderer.on('agent:done', handler);
    return () => ipcRenderer.removeListener('agent:done', handler);
  },

  /** Listen for tool execution start */
  onToolStart(callback: (toolCallId: string, toolName: string) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      toolCallId: string,
      toolName: string,
    ): void => callback(toolCallId, toolName);
    ipcRenderer.on('agent:tool-start', handler);
    return () => ipcRenderer.removeListener('agent:tool-start', handler);
  },

  /** Listen for tool execution end */
  onToolEnd(callback: (result: ToolResult) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, result: ToolResult): void =>
      callback(result);
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
    const handler = (_event: Electron.IpcRendererEvent, content: string): void =>
      callback(content);
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
  async createSession(name: string): Promise<SessionMeta> {
    return ipcRenderer.invoke('session:create', name);
  },

  /** Load session messages */
  async loadSession(id: string): Promise<Message[]> {
    return ipcRenderer.invoke('session:load', id);
  },

  /** Save a message to the current session */
  async saveMessage(message: Message): Promise<void> {
    return ipcRenderer.invoke('session:saveMessage', message);
  },

  /** Export session to HTML */
  async exportSession(id: string): Promise<string> {
    return ipcRenderer.invoke('session:export', id);
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
  async getModels(provider: string): Promise<Array<{
    id: string; name: string; provider: string;
    contextWindow: number; maxTokens: number;
    supportsReasoning: boolean; supportsImages: boolean;
  }>> {
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

  /** Get current working directory */
  async getWorkingDir(): Promise<string> {
    return ipcRenderer.invoke('app:getWorkingDir');
  },
};

contextBridge.exposeInMainWorld('suncode', suncodeAPI);

export type SunCodeAPI = typeof suncodeAPI;
