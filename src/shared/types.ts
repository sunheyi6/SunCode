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

/** Result of a tool execution */
export interface ToolResult {
  toolCallId: string;
  name: string;
  success: boolean;
  output: string;
  error?: string;
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
  | { type: 'toolStart'; toolCallId: string; toolName: string }
  | { type: 'toolEnd'; toolResult: ToolResult };

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
  error?: string;
  message?: Message; // final message on 'done'
}

// ===== IPC API Types (Renderer ↔ Main) =====

/** Events emitted from main process to renderer */
export interface AgentEventCallbacks {
  onStreamEvent: (event: StreamEvent) => void;
  onStatusChange: (status: AgentStatus) => void;
  onError: (message: string) => void;
  onDone: (message: Message) => void;
  onToolStart: (toolCallId: string, toolName: string) => void;
  onToolEnd: (result: ToolResult) => void;
}

/** Settings update callback */
export type SettingsListener = (settings: AppSettings) => void;
