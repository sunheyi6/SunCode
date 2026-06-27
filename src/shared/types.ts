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
  /** Per-turn LLM request/response details (persisted for call trace panel). */
  turnDetails?: TurnDetail[];
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
  /** Path to temp file with full output when truncated. */
  fullOutputPath?: string;
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
  /** Max lessons to retain. Default 200. */
  maxLessons?: number;
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
  | 'completed' // Task completed normally (## 最终结果 标记 or task_complete)
  | 'max_turns_exhausted' // Turn budget exhausted
  | 'aborted' // User aborted
  | 'blocked' // Blocked by stop hook (e.g. verification failed)
  | 'error'; // Stream/LLM error

/** Structured decision about whether to continue or stop the agent loop. */
export type TurnDecision =
  | { decision: 'continue'; reason?: string }
  | {
      decision: 'stop';
      reason:
        | 'task_complete'
        | 'final_result'
        | 'no_follow_up'
        | 'missing_final_result'
        | 'max_turns'
        | 'aborted'
        | 'blocked'
        | 'error';
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
  | { type: 'prompt'; sessionId: string; text: string; attachments?: string[] }
  | { type: 'abort'; sessionId: string }
  | { type: 'continue'; sessionId: string }
  | { type: 'config'; settings: AppSettings }
  | { type: 'setWorkingDir'; sessionId: string; path: string }
  | { type: 'setMessages'; sessionId: string; messages: Message[] }
  | { type: 'confirmResponse'; sessionId: string; toolCallId: string; confirmed: boolean }
  | { type: 'killBgProcess'; sessionId: string; pid: number };

/** Messages sent from agent worker to main process */
export type WorkerOutMessage =
  | { type: 'stream'; sessionId: string; event: StreamEvent }
  | { type: 'status'; sessionId: string; status: AgentStatus }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'done'; sessionId: string; message: Message }
  | { type: 'toolStart'; sessionId: string; toolCall: ToolCallContent }
  | { type: 'toolEnd'; sessionId: string; toolResult: ToolResult }
  | { type: 'bgProcessStarted'; sessionId: string; process: BackgroundProcess }
  | { type: 'bgProcessCompleted'; sessionId: string; pid: number; exitCode: number }
  | { type: 'runStarted'; sessionId: string; runId: string }
  | { type: 'runEvent'; sessionId: string; event: RunEvent }
  | { type: 'subagentStart'; sessionId: string; execution: SubagentExecution }
  | { type: 'subagentEnd'; sessionId: string; id: string; result: SubagentResult }
  | { type: 'subagentProgress'; sessionId: string; executionId: string; agent: string; delta: SubagentProgressDelta }
  | { type: 'goalEvent'; sessionId: string; event: GoalEvent }
  | { type: 'confirmRequest'; sessionId: string; toolCall: ToolCallContent };

/** Streaming event types from the LLM */
/**
 * Streamed message data — assembled on the worker side, sent as a complete
 * snapshot on each message_update. Replaces the old delta-level approach
 * (text_delta, thinking_delta, toolcall_delta).
 */
export interface StreamMessageData {
  text: string;
  thinking: string;
  toolCalls: ToolCallContent[];
  /** True when the message is complete (final text_end / message_end). */
  isFinished?: boolean;
  /** stopReason from the LLM response (only on final update). */
  stopReason?: string;
  /** Error message if the stream failed. */
  error?: string;
}

export type StreamEventType =
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'turn_start'
  | 'turn_end'
  | 'error'
  | 'system_prompt';

/** A streaming event from the LLM */
export interface StreamEvent {
  type: StreamEventType;
  /** Assembled message data (message_start / message_update / message_end). */
  data?: StreamMessageData;
  /** For turn_start: current turn number / max turns */
  turnCount?: number;
  maxTurns?: number;
  /** For turn_end: whether this turn had tool calls (intermediate) */
  hasToolCalls?: boolean;
  error?: string;
  /** Final assembled message on message_end (for persistence). */
  message?: Message;
  /** System prompt text (emitted once at the start of each agent run). */
  systemPrompt?: string;
}

// ===== Run Event Types =====

/** Per-turn LLM request/response detail (CallTracePanel rendering). */
export interface TurnDetail {
  turnNumber: number;
  systemTokens: number;
  requestMessages: Array<{ role: string; length: number; preview: string }>;
  response: {
    text: string;
    thinking: string;
    toolCalls: ToolCallContent[];
    stopReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    durationMs?: number;
  };
}

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
  | {
      type: 'model_request_started';
      runId: RunId;
      turnNumber: number;
      attempt: number;
      provider: string;
      model: string;
      timestamp: string;
    }
  | {
      type: 'model_request_completed';
      runId: RunId;
      turnNumber: number;
      attempt: number;
      provider: string;
      model: string;
      durationMs: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      stopReason?: string;
      error?: string;
      timestamp: string;
      /** (Call trace) Message summaries sent to the LLM for this turn. */
      requestMessages?: Array<{ role: string; length: number; preview: string }>;
      /** (Call trace) System prompt token count for this turn. */
      systemTokens?: number;
      /** (Call trace) The LLM's visible text response. */
      responseText?: string;
      /** (Call trace) The LLM's thinking/reasoning response. */
      responseThinking?: string;
      /** (Call trace) Tool calls the LLM requested. */
      responseToolCalls?: ToolCallContent[];
    }
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

// ===== Lesson Types =====

/** 教训触发类型 */
export type LessonTriggerType =
  | 'tool_failure'
  | 'user_correction'
  | 'run_error'
  | 'goal_repeated_failure';

/** 单条教训条目 */
export interface LessonEntry {
  /** 文件名中的 slug */
  slug: string;
  /** 触发类型 */
  type: LessonTriggerType;
  /** 涉及的工具名（无则为空字符串） */
  tool: string;
  /** 关键词 */
  keywords: string[];
  /** 相关文件路径 */
  files: string[];
  /** ISO 日期 (YYYY-MM-DD) */
  date: string;
  /** 来源 runId */
  runId: string;
  /** 一句话标题（中文，≤30字） */
  title: string;
  /** 问题描述（≤200字） */
  problem: string;
  /** 根本原因（≤200字） */
  rootCause: string;
  /** 正确做法（≤200字） */
  solution: string;
}

/** 教训索引（LESSONS.md 的内存表示） */
export interface LessonIndex {
  /** 按日期倒序排列的条目 */
  entries: LessonEntry[];
  /** 最后更新时间 (ISO) */
  updatedAt: string;
}

/** 搜索结果 */
export interface LessonSearchResult {
  entry: LessonEntry;
  /** 匹配打分（关键词交集计数） */
  score: number;
}

/** 提取上下文（传入 extractLessonsIfNeeded 的原始材料） */
export interface LessonExtractionContext {
  triggerType: LessonTriggerType;
  /** 最近几轮消息（含工具调用和结果） */
  relevantMessages: Message[];
  /** 错误详情（可选） */
  error?: string;
  /** 关联的 runId */
  runId: string;
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

// ===== Auto Update Types =====

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'update-available'
  | 'downloading'
  | 'downloaded'
  | 'no-update'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  releaseDate?: string;
  releaseNotes?: string;
  downloadProgress?: number;
  downloadBytesPerSecond?: number;
  error?: string;
  skippedVersion?: string;
}

// ===== Task Plan Types =====

/** Classification of a user request — query (只读查看) or execution (需要修改/执行). */
export type TaskType = 'query' | 'execution';

/** Status of a single step in a task plan. */
export type StepStatus = 'pending' | 'in_progress' | 'done';

/** A single step in a task execution plan. */
export interface TaskStep {
  /** Unique identifier, e.g. "step_1" */
  id: string;
  /** 1-based step number */
  index: number;
  /** Human-readable step description (verb-first) */
  description: string;
  /** Current status */
  status: StepStatus;
  /** Optional one-line result summary when the step is done */
  result?: string;
}

/** Structured task plan parsed from the model's text output. */
export interface TaskPlan {
  /** Whether this is a query or execution task */
  taskType: TaskType;
  /** Ordered list of execution steps */
  steps: TaskStep[];
}
