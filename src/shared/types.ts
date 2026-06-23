// ===== Core Message Types =====

/** Role of a message in the conversation */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** Text content block within a message */
export interface TextContent {
  type: 'text';
  text: string;
}

/** Tool call content block within an assistant message */
export interface ToolCallContent {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: string;
  status?: ToolExecutionStatus;
  result?: ToolResult;
  /** Offset into the thinking text stream where this tool call appeared (for interleaved rendering). */
  thinkingOffset?: number;
}

/** Thinking/reasoning content block */
export interface ThinkingContent {
  type: 'thinking';
  text: string;
}

/** Image content block */
export interface ImageContent {
  type: 'image';
  base64: string;
  mimeType: string;
}

/** Union of all content block types */
export type ContentBlock = TextContent | ToolCallContent | ThinkingContent | ImageContent;

/** A message in the conversation */
export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
  toolCallId?: string;
  /** Only on assistant messages with tool calls */
  toolCalls?: ToolCallContent[];
}

// ===== Tool Types =====

/** JSON Schema for tool parameters (simplified) */
export interface ToolParameterSchema {
  type: string;
  description?: string;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
  items?: ToolParameterSchema;
  enum?: string[];
}

/** Tool definition exposed to the LLM */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export type FileEditStatus = 'editing' | 'edited' | 'failed';

export interface FileEditDetails {
  type: 'file_edit';
  filePath: string;
  status: FileEditStatus;
  addedLines?: number;
  removedLines?: number;
  error?: string;
}

export interface CommandDetails {
  type: 'command';
  command: string;
  cwd: string;
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
}

export type ToolResultDetails = FileEditDetails | CommandDetails;
export type ToolExecutionStatus = 'running' | 'done' | 'error';

/** Result of a tool execution */
export interface ToolResult {
  toolCallId: string;
  name: string;
  success: boolean;
  output: string;
  error?: string;
  details?: ToolResultDetails;
  /** PID when run in background */
  pid?: number;
}

/** Info about a background process started by Bash tool */
export interface BackgroundProcess {
  pid: number;
  command: string;
  startTime: number;
  status: 'running' | 'completed' | 'error';
  exitCode?: number;
  endTime?: number;
}

/** Tool implementation interface */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameterSchema;
  execute(params: Record<string, unknown>): Promise<ToolResult>;
  getDefinition(): ToolDefinition;
}

// ===== Agent Types =====

/** Current agent state */
export type AgentState = 'idle' | 'thinking' | 'executing' | 'done' | 'error';

/** Status update from the agent worker */
export interface AgentStatus {
  state: AgentState;
  turnCount: number;
  tokenUsage: TokenUsage;
  modelName: string;
}

/** Token usage information */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cost?: number;
}

// ===== File Types =====

/** A node in the file tree */
export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  size?: number;
  modified?: string;
}

// ===== Session Types =====

/** Session metadata */
export interface SessionMeta {
  id: string;
  name: string;
  created: string;
  updated: string;
  messageCount: number;
  workingDirectory: string;
}

// ===== Settings Types =====

/** Application settings */
export interface AppSettings {
  activeModel: string;
  activeProvider: string;
  thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  maxTurns: number;
  autoCompact: boolean;
  compactThreshold: number; // 0-1 fraction of context window
  theme: 'system' | 'light' | 'dark';
  /** Agent permission mode */
  permissionMode: 'plan' | 'full_access' | 'auto_edit' | 'confirm_changes';
  mcpServers: McpServerConfig[];
  skills: string[]; // paths to skill directories
  envApiKeys: Record<string, string>;
}

/** MCP server configuration */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

// ===== Worker Messages =====

/** Messages sent from main process to agent worker */
export type WorkerInMessage =
  | { type: 'prompt'; text: string; attachments?: string[] }
  | { type: 'abort' }
  | { type: 'continue' }
  | { type: 'config'; settings: AppSettings }
  | { type: 'setWorkingDir'; path: string }
  | { type: 'setMessages'; messages: Message[] };

/** Messages sent from agent worker to main process */
export type WorkerOutMessage =
  | { type: 'stream'; event: StreamEvent }
  | { type: 'status'; status: AgentStatus }
  | { type: 'error'; message: string }
  | { type: 'done'; message: Message }
  | { type: 'toolStart'; toolCall: ToolCallContent }
  | { type: 'toolEnd'; toolResult: ToolResult }
  | { type: 'bgProcessStarted'; process: BackgroundProcess }
  | { type: 'bgProcessCompleted'; pid: number; exitCode: number }
  | { type: 'runStarted'; runId: string }
  | { type: 'runEvent'; event: RunEvent };

/** Streaming event types from the LLM */
export type StreamEventType =
  | 'text_start'
  | 'text_delta'
  | 'text_end'
  | 'thinking_start'
  | 'thinking_delta'
  | 'thinking_end'
  | 'toolcall_start'
  | 'toolcall_delta'
  | 'toolcall_end'
  | 'turn_start'
  | 'turn_end'
  | 'start'
  | 'done'
  | 'error';

/** A streaming event from the LLM */
export interface StreamEvent {
  type: StreamEventType;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  delta?: string;
  /** For turn_start: current turn number / max turns */
  turnCount?: number;
  maxTurns?: number;
  /** For turn_end: whether this turn had tool calls (intermediate) */
  hasToolCalls?: boolean;
  error?: string;
  message?: Message; // final message on 'done'
  /** Unique identifier for the current agent run (LLM invocation chain). */
  runId?: string;
}

// ===== Run Event Types =====

/** Unique identifier for an agent run. */
export type RunId = string;

/** Events recorded in the per-run JSONL event log. */
export type RunEvent =
  | { type: 'run_started'; runId: RunId; timestamp: string }
  | { type: 'turn_started'; runId: RunId; turnNumber: number; timestamp: string }
  | { type: 'stream_event'; runId: RunId; event: StreamEvent; timestamp: string }
  | { type: 'tool_started'; runId: RunId; toolCallId: string; toolName: string; timestamp: string }
  | {
      type: 'tool_completed';
      runId: RunId;
      toolCallId: string;
      toolName: string;
      success: boolean;
      timestamp: string;
    }
  | {
      type: 'turn_completed';
      runId: RunId;
      turnNumber: number;
      hasToolCalls: boolean;
      timestamp: string;
    }
  | { type: 'run_completed'; runId: RunId; turnCount: number; timestamp: string }
  | { type: 'run_failed'; runId: RunId; error: string; timestamp: string }
  | { type: 'run_aborted'; runId: RunId; timestamp: string }
  | { type: 'run_recovered'; runId: RunId; reason: string; timestamp: string };

// ===== IPC API Types (Renderer ↔ Main) =====

/** Events emitted from main process to renderer */
export interface AgentEventCallbacks {
  onStreamEvent: (event: StreamEvent) => void;
  onStatusChange: (status: AgentStatus) => void;
  onError: (message: string) => void;
  onDone: (message: Message) => void;
  onToolStart: (toolCall: ToolCallContent) => void;
  onToolEnd: (result: ToolResult) => void;
}

/** Settings update callback */
export type SettingsListener = (settings: AppSettings) => void;

// ===== Git Types =====

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  remoteUrl?: string;
  addedLines: number;
  deletedLines: number;
  changedFiles: number;
  stagedFiles: number;
}
