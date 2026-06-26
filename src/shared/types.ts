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
  /** System prompt for this run (persisted for call trace panel). */
  systemPrompt?: string;
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
  /** Pre-edit content for diff display (truncated to relevant section). */
  oldContent?: string;
  /** Post-edit content for diff display (truncated to relevant section). */
  newContent?: string;
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
  /** Sub-agent results (only for the subagent tool) */
  subagentResults?: SubagentResult[];
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
  fontSize: number; // base font size in px, default 14
  mcpServers: McpServerConfig[];
  skills: string[]; // paths to skill directories
  envApiKeys: Record<string, string>;
  /** Goal mode: max goal-level turns (each turn = one full agent run). Default 5. */
  goalMaxTurns?: number;
  /** Goal mode: max wall-clock time in milliseconds. Default 600000 (10 min). */
  goalMaxWallTimeMs?: number;
}

/** MCP server configuration */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

// ===== Turn Decision Types =====

/** Structured outcome taxonomy for a turn/run termination. */
export type TurnTaxonomy =
  | 'completed' // Task completed normally (task_complete or no_follow_up)
  | 'max_turns_exhausted' // Turn budget exhausted
  | 'aborted' // User aborted
  | 'blocked' // Blocked by stop hook (e.g. verification failed)
  | 'error'; // Stream/LLM error

/** Structured decision about whether to continue or stop the agent loop. */
export type TurnDecision =
  | { decision: 'continue'; reason?: string }
  | {
      decision: 'stop';
      reason: 'task_complete' | 'no_follow_up' | 'max_turns' | 'aborted' | 'blocked' | 'error';
      taxonomy: TurnTaxonomy;
    };

// ===== Goal Types =====

/** User-defined goal for autonomous multi-turn execution. */
export interface GoalDefinition {
  /** Human-readable description of the desired end state. */
  description: string;
  /** Shell command that must exit 0 for the goal to be considered met. */
  verificationCommand?: string;
  /** Constraints the agent must respect while working toward the goal. */
  constraints?: string;
  /** Maximum goal-level turns (each turn = one full agent run). */
  maxGoalTurns?: number;
  /** Maximum wall-clock time in milliseconds for the entire goal. */
  maxWallTimeMs?: number;
}

/** Current status of a goal execution. */
export type GoalStatus =
  | 'active' // Goal is being worked on
  | 'verification_passed' // Verification command exited 0 → goal met
  | 'budget_exhausted' // Turn or time budget hit
  | 'blocked' // No valid path remains
  | 'aborted'; // User cancelled

/** Runtime state of a goal execution. */
export interface GoalState {
  definition: GoalDefinition;
  status: GoalStatus;
  turnsCompleted: number;
  tokenUsage: TokenUsage;
  lastVerificationOutput?: string;
  lastVerificationExitCode?: number | null;
  startedAt: number;
  reason?: string; // why the goal stopped (when not verification_passed)
}

/** Events emitted during goal execution. */
export type GoalEvent =
  | { type: 'goal_started'; goal: GoalDefinition; goalRunId: string }
  | {
      type: 'goal_turn_completed';
      turnNumber: number;
      tokenUsage: TokenUsage;
      verificationOutput?: string;
      verificationExitCode?: number | null;
    }
  | { type: 'goal_verification_passed'; tokenUsage: TokenUsage }
  | { type: 'goal_budget_exhausted'; reason: string }
  | { type: 'goal_blocked'; reason: string }
  | { type: 'goal_aborted' }
  | { type: 'goal_completed'; state: GoalState };

/** Result of a goal loop execution. */
export interface GoalLoopResult {
  goalRunId: string;
  state: GoalState;
  finalMessage: Message;
  totalTurnCount: number;
  tokenUsage: TokenUsage;
}

// ===== Stop Hook Types =====

/** Context provided to stop hooks for decision-making. */
export interface StopHookContext {
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallContent[];
  toolResults: ToolResult[];
  turnCount: number;
  maxTurns: number;
  tokenUsage: TokenUsage;
  /** If goal is active, the goal definition. */
  goal?: GoalDefinition;
}

/** Result of a stop hook check. */
export interface StopHookResult {
  /** Block turn completion and inject a continuation prompt. */
  shouldBlock: boolean;
  /** Force immediate termination. */
  shouldStop: boolean;
  /** Prompt to inject when shouldBlock is true. */
  continuationPrompt?: string;
  /** Human-readable reason for the decision. */
  reason?: string;
}

/** A stop hook that runs before a turn is finalized. */
export interface StopHook {
  name: string;
  /** Execution priority (lower number = earlier execution). */
  priority: number;
  /** Check whether the turn should be blocked or stopped. */
  check(ctx: StopHookContext): Promise<StopHookResult>;
}

/** Registry of stop hooks, run in priority order before turn finalization. */
export interface StopHookRegistry {
  register(hook: StopHook): void;
  runAll(ctx: StopHookContext): Promise<StopHookResult>;
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
  | { type: 'runEvent'; event: RunEvent }
  | { type: 'subagentStart'; execution: SubagentExecution }
  | { type: 'subagentEnd'; id: string; result: SubagentResult }
  | { type: 'subagentProgress'; executionId: string; agent: string; delta: SubagentProgressDelta }
  | { type: 'goalEvent'; event: GoalEvent };

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
  | 'error'
  | 'system_prompt';

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
  /** System prompt text (emitted once at the start of each agent run). */
  systemPrompt?: string;
}

// ===== Run Event Types =====

/** Unique identifier for an agent run. */
export type RunId = string;

/** Events recorded in the per-run JSONL event log. */
export type RunEvent =
  | { type: 'run_started'; runId: RunId; timestamp: string; modelName?: string }
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
      taxonomy?: TurnTaxonomy;
    }
  | {
      type: 'run_completed';
      runId: RunId;
      turnCount: number;
      timestamp: string;
      tokenUsage?: { input: number; output: number; total: number };
      taxonomy?: TurnTaxonomy;
    }
  | { type: 'run_failed'; runId: RunId; error: string; timestamp: string }
  | { type: 'run_aborted'; runId: RunId; timestamp: string }
  | { type: 'run_recovered'; runId: RunId; reason: string; timestamp: string }
  | { type: 'goal_started'; runId: RunId; goal: GoalDefinition; timestamp: string }
  | {
      type: 'goal_turn_completed';
      runId: RunId;
      turnNumber: number;
      timestamp: string;
      verificationExitCode?: number | null;
    }
  | { type: 'goal_completed'; runId: RunId; status: GoalStatus; timestamp: string };

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

// ===== Stats Types =====

export interface TokenUsageSummary {
  /** Daily aggregated token usage */
  daily: DayStats[];
  /** Per-model aggregated token usage */
  byModel: ModelStats[];
  /** Grand totals */
  totals: { input: number; output: number; total: number; runs: number };
}

export interface DayStats {
  date: string; // YYYY-MM-DD
  input: number;
  output: number;
  total: number;
  runs: number;
}

export interface ModelStats {
  modelName: string;
  input: number;
  output: number;
  total: number;
  runs: number;
}

// ===== Subagent Types =====

/** Definition of a sub-agent loaded from .suncode/agents/*.md */
export interface SubagentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[]; // allowed tool names (whitelist)
  model?: string;
  thinking?: string;
  maxTurns?: number;
}

/** A single sub-agent delegation call */
export interface SubagentCall {
  agent: string;
  prompt: string;
  session?: string; // persistent session handle
  initialContext?: 'empty' | 'parent';
  model?: string;
}

/** Result from a sub-agent execution */
export interface SubagentResult {
  agent: string;
  session?: string;
  success: boolean;
  output: string;
  toolCalls: number;
  tokenUsage: { input: number; output: number; total: number };
  error?: string;
  /** Sub-agent's internal thinking stream (for display in SubagentCard). */
  thinking?: string;
  /** Sub-agent's internal tool calls with results (for display in SubagentCard). */
  internalCalls?: ToolCallContent[];
}

/** Runtime state of a sub-agent execution */
export type SubagentState = 'pending' | 'running' | 'done' | 'error';

/** Runtime info about an active sub-agent (for UI) */
export interface SubagentExecution {
  id: string;
  agent: string;
  state: SubagentState;
  startTime: number;
  prompt: string;
  result?: SubagentResult;
}

/** Incremental progress update from a running sub-agent */
export interface SubagentProgressDelta {
  type: 'thinking' | 'tool_start' | 'tool_end';
  text?: string;
  toolCall?: ToolCallContent;
  toolResult?: ToolResult;
}

// ===== Context Budget Types =====

/** Placeholder replacing an oversized tool result in conversation context. */
export interface ArchivedToolResultPlaceholder {
  kind: 'suncode.archived_tool_result';
  toolCallId: string;
  toolName: string;
  bodyHash: string;
  originalTokens: number;
  originalChars: number;
  reason: 'pruned_exceeds_budget';
}

/** Policy for pruning stale tool results from conversation context. */
export interface StaleToolResultPrunePolicy {
  enabled: boolean;
  /** Tool results above this estimated token count are replaced with placeholders. Default 2048. */
  maxResultTokens?: number;
  /** Keep this many newest turns' tool results intact. Default 1. */
  minRecentTurnsFull?: number;
}

/** Policy for history compaction (turn-level summarization). */
export interface HistoryCompactPolicy {
  enabled: boolean;
  /** Trigger when prior history exceeds this ratio of context window. Default 0.8. */
  highWaterRatio?: number;
  /** Turns to keep intact after compaction. Default 3. */
  keepRecentTurns?: number;
}

/** Top-level context budget policy. */
export interface ContextBudgetPolicy {
  /** Max estimated tokens for prior history. Falls back to model contextWindow * 0.9. */
  maxHistoryTokens?: number;
  /** Max turns to retain. */
  maxHistoryTurns?: number;
  /** Always keep at least this many recent turns. Default 2. */
  minRecentTurns?: number;
  /** Token estimation ratio. Default 4 chars/token. */
  charsPerToken?: number;
  /** Stale tool result pruning configuration. */
  staleToolResultPrune?: StaleToolResultPrunePolicy;
  /** History compaction configuration. */
  historyCompact?: HistoryCompactPolicy;
}

/** Diagnostic info emitted after context budget is applied. */
export interface ContextBudgetDiagnostic {
  changed: boolean;
  beforeTokens: number;
  afterTokens: number;
  beforeMessages: number;
  afterMessages: number;
  prunedToolResults?: number;
  prunedTokensSaved?: number;
  droppedTurns?: number;
  compactedTurns?: number;
}

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
