// ===== Core Message Types =====

/** Role of a message in the conversation */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** User-facing language for localized UI and model responses. */
export type UiLanguage = 'zh' | 'en';

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
  /** Real-time partial output streamed during tool execution. */
  partialOutput?: string;
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
  /** Runtime-only model context projection; not a user-authored message. */
  contextKind?: 'capacity_summary' | 'semantic_projection';
  toolCallId?: string;
  /** UI language selected from the user prompt for localized progress display. */
  uiLanguage?: UiLanguage;
  /** Only on assistant messages with tool calls */
  toolCalls?: ToolCallContent[];
  /** System prompt for this run (persisted for call trace panel). */
  systemPrompt?: string;
  /** Per-turn LLM request/response details (persisted for call trace panel). */
  turnDetails?: TurnDetail[];
  /** Structured task plan accumulated across turns (persisted for the plan panel). */
  taskPlan?: TaskPlan;
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
  /** Ports the caller expects to become reachable (background processes). */
  expectedPorts?: number[];
  /** Ports confirmed reachable at the time the tool result was returned. */
  portsReachable?: number[];
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
  /** PID actually monitored for liveness. Defaults to pid. Useful when a launcher hands off to an app process. */
  monitorPid?: number;
  command: string;
  startTime: number;
  status: 'running' | 'completed' | 'error';
  exitCode?: number;
  endTime?: number;
  /** Set when the user manually kills the process (via stop button) */
  killed?: boolean;
  /** Ports the caller expects to become reachable after startup */
  expectedPorts?: number[];
  /** Ports confirmed reachable via automated TCP check */
  portsReachable?: number[];
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
  /** Git worktree branch name if this session uses a Git worktree (undefined = no worktree). */
  gitWorktreeBranch?: string;
  /** Git worktree path (the working tree checkout directory). */
  gitWorktreePath?: string;
  /** Original main repo path for worktree cleanup. */
  gitMainRepoPath?: string;
}

// ===== Custom Endpoints =====

/** 自定义端点的 API 协议格式，与 pi-ai 的 KnownApi 对齐。 */
export type CustomApiFormat = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

/** 自定义端点下的单个模型条目。 */
export interface CustomModelEntry {
  /** 必填，模型 id，发送给端点。 */
  id: string;
  /** 可选显示名，留空则用 id。 */
  name?: string;
  /** 可选上下文窗口（token），默认 128000。 */
  contextWindow?: number;
}

/** 自定义端点（一个 URL + Key + API 格式下挂多个模型）。 */
export interface CustomEndpoint {
  /** 系统 provider id，由显示名 slugify 生成，确保唯一。 */
  id: string;
  /** 显示名。 */
  name: string;
  /** Base URL。 */
  baseUrl: string;
  /** API Key（独立存储，不复用 envApiKeys）。 */
  apiKey: string;
  apiFormat: CustomApiFormat;
  models: CustomModelEntry[];
}

// ===== Settings Types =====

/** Selectable design styles (dark brand palettes applied via `data-style`). */
export type AppearanceStyle =
  | 'apple'
  | 'linear'
  | 'vercel'
  | 'raycast'
  | 'cursor'
  | 'notion'
  | 'stripe'
  | 'spotify';

/** Application settings */
export interface AppSettings {
  activeModel: string;
  activeProvider: string;
  thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  maxTurns: number;
  autoCompact: boolean;
  compactThreshold: number; // 0-1 fraction of context window
  /** Active-turn semantic projection. Off by default until controlled evaluation. */
  semanticCompactMode: 'off' | 'shadow' | 'replace';
  semanticCompactThreshold: number;
  semanticCompactMinNewTokens: number;
  semanticCompactMaxOutputTokens: number;
  theme: 'system' | 'light' | 'dark';
  /**
   * Design style / brand theme. Selects a color palette via the `data-style`
   * attribute on <html>. Each style has both a dark and a light variant, so it
   * applies in both dark and light mode. 'apple' preserves the default look.
   */
  appearance?: AppearanceStyle;
  /**
   * Optional global background color override (hex, e.g. `#1a1a2e`).
   * When unset/empty, the active theme palette is used.
   */
  backgroundColor?: string;
  /** Agent permission mode */
  permissionMode: 'plan' | 'full_access' | 'auto_edit' | 'confirm_changes';
  /** Shell preference for command execution on Windows. */
  windowsShell: 'auto' | 'git_bash' | 'powershell';
  /** How plan approval requests are handled when the agent enters Plan Mode. */
  planApprovalMode?: 'interactive' | 'auto_approve' | 'disabled';
  fontSize: number; // base font size in px, default 14
  mcpServers: McpServerConfig[];
  skills: string[]; // paths to skill directories
  /** Absolute SKILL.md paths that should not be included in the agent prompt. */
  disabledSkills?: string[];
  envApiKeys: Record<string, string>;
  /** 自定义端点列表（仅全局存储）。 */
  customEndpoints: CustomEndpoint[];
  /** Max lessons to retain. Default 200. */
  maxLessons?: number;
  /** Goal mode: max goal-level turns (each turn = one full agent run). Default 5. */
  goalMaxTurns?: number;
  /** Goal mode: max wall-clock time in milliseconds. Default 600000 (10 min). */
  goalMaxWallTimeMs?: number;
  /** When to show a native notification after a task completes. Default 'never'. */
  taskCompleteNotification?: 'never' | 'always' | 'unfocused';
  /** Whether to auto-create a Git worktree for each new session. Default false. */
  createGitWorktree?: boolean;
  /** Whether to show the model's thinking/reasoning process in the UI. Default true. */
  showThinking?: boolean;
}

/** A skill discovered from SunCode or a compatible coding agent installation. */
export interface DiscoveredSkill {
  name: string;
  path: string;
  description: string;
  source: string;
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

// ===== Error Recovery Types =====

/**
 * Continue sites for error recovery in the agent loop.
 * Each site represents a distinct recovery strategy for a specific failure mode.
 */
export type ContinueSite =
  | 'next_turn' // Normal: tool execution completed, continue loop
  | 'max_output_recovery' // Model output truncated → retry with larger max_output_tokens
  | 'max_output_continuation' // Inject continuation prompt after max_output_recovery fails
  | 'context_overflow_recovery' // Context overflow → trigger emergency compression then retry
  | 'stop_hook_blocking'; // Stop hook returned shouldBlock → inject feedback

/** Recovery state tracking across retry attempts. */
export interface RecoveryContext {
  site: ContinueSite;
  attempt: number;
  maxAttempts: number;
  /** Original max_output_tokens before escalation. */
  originalMaxOutputTokens?: number;
}

// ===== Plan Mode Types =====

/** Phase of the plan mode workflow. */
export type PlanPhase = 'exploring' | 'implementing';

/** Runtime state for plan mode. */
export interface PlanState {
  phase: PlanPhase;
  /** Permission mode saved before entering plan mode, restored on exit. */
  savedPermissionMode: AppSettings['permissionMode'];
  /** Path to the plan file being written. */
  planFilePath: string;
  /** Whether the plan was approved by the user. */
  approved?: boolean;
  /** Number of turns spent in plan mode so far. */
  planTurnCount: number;
  /** Maximum turns allowed in plan mode before forced exit. */
  maxTurns: number;
}

/** Events emitted during plan mode transitions. */
export type PlanModeEvent =
  | { type: 'plan_entered'; planFilePath: string }
  | { type: 'plan_approved'; planFilePath: string }
  | { type: 'plan_rejected'; planFilePath: string }
  | { type: 'plan_exited'; restoredMode: AppSettings['permissionMode'] };

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

// ===== Extended Hook System Types =====

/** Events the hook system can intercept. */
export type HookEventType =
  | 'pre_tool_use' // Before a tool is executed
  | 'post_tool_use' // After a tool completes successfully
  | 'post_tool_use_failure' // After a tool fails
  | 'permission_request' // When permission confirmation is needed
  | 'stop' // Before turn finalization (backward compatible with StopHook)
  | 'session_start' // When a new session begins
  | 'session_end' // When a session ends
  | 'subagent_start' // When a sub-agent is dispatched
  | 'subagent_stop'; // When a sub-agent completes

/** Unified context passed to all hook types. */
export interface HookContext {
  eventType: HookEventType;
  /** Tool call data (for pre_tool_use, post_tool_use, post_tool_use_failure, permission_request). */
  toolCall?: ToolCallContent;
  /** Tool result (for post_tool_use, post_tool_use_failure). */
  toolResult?: ToolResult;
  /** Stop hook context fields (for 'stop' events). */
  assistantText?: string;
  thinkingText?: string;
  toolCalls?: ToolCallContent[];
  toolResults?: ToolResult[];
  turnCount?: number;
  maxTurns?: number;
  tokenUsage?: TokenUsage;
  /** Sub-agent information (for subagent_start, subagent_stop). */
  subagentName?: string;
  sessionId?: string;
}

/** Result from a hook execution. */
export interface HookResult {
  /** Whether to block the action (with optional continuation prompt). */
  shouldBlock: boolean;
  /** Whether to force immediate stop. */
  shouldStop: boolean;
  /** Prompt to inject when shouldBlock is true. */
  continuationPrompt?: string;
  /** Human-readable reason. */
  reason?: string;
  /** Whether to allow the action (for permission_request hooks). */
  allow?: boolean;
}

/** A hook that runs on specific events. */
export interface HookInterface {
  name: string;
  /** Execution priority (lower number = earlier execution). */
  priority: number;
  /** Which event types this hook listens to. */
  eventTypes: HookEventType[];
  /** Check/execute the hook. First hook returning a non-neutral result wins. */
  check(ctx: HookContext): Promise<HookResult>;
}

/** Registry for the extended hook system. */
export interface HookRegistry {
  register(hook: HookInterface): void;
  unregister(name: string): void;
  /** Run all matching hooks for an event. Returns the first non-neutral result. */
  runEvent(eventType: HookEventType, ctx: HookContext): Promise<HookResult>;
}

// ===== Permission Rule Types =====

/** How a rule pattern is matched against a tool name. */
export type RuleMatchMode = 'exact' | 'prefix' | 'wildcard';

/** Permission rule source priority (higher = more authoritative). */
export type RuleSource =
  | 'policySettings' // Enterprise MDM (highest)
  | 'userSettings' // User-level ~/.suncode/permissions.json
  | 'projectSettings' // Project-level .suncode/permissions.json
  | 'localSettings' // Workspace local
  | 'flagSettings' // CLI flags
  | 'cliArg' // Per-invocation CLI args
  | 'command' // In-command override
  | 'session'; // Session-level (lowest)

/** A single permission rule. */
export interface PermissionRule {
  type: 'allow' | 'deny';
  /** Tool name pattern to match. */
  toolPattern: string;
  /** How to interpret the pattern. */
  matchMode: RuleMatchMode;
  /** Where this rule came from (determines priority). */
  source: RuleSource;
  /** Optional argument filter (key=value). */
  argFilter?: Record<string, string>;
}

/** Set of permission rules with resolution logic. */
export interface PermissionRuleSet {
  rules: PermissionRule[];
  /**
   * Resolve whether a tool call is allowed.
   * Returns 'allow' | 'deny' | 'uncertain'.
   * Deny rules always take precedence regardless of source.
   */
  resolve(toolName: string, params: Record<string, unknown>): 'allow' | 'deny' | 'uncertain';
}

// ===== Streaming Tool Pre-execution Types =====

/** A tool call that was pre-executed during streaming. */
export interface PreExecutedToolCall {
  toolCallId: string;
  toolName: string;
  /** The execution promise (settled by the time streaming completes). */
  resultPromise: Promise<ToolResult>;
  /** Whether this tool is read-only (can pre-execute without confirmation). */
  isReadOnly: boolean;
}

// ===== Worker Messages =====

/** Messages sent from main process to agent worker */
export type WorkerInMessage =
  | {
      type: 'prompt';
      sessionId: string;
      text: string;
      uiLanguage?: UiLanguage;
      attachments?: string[];
    }
  | { type: 'abort'; sessionId: string }
  | { type: 'stop'; sessionId: string }
  | { type: 'continue'; sessionId: string }
  | { type: 'injectGuidance'; sessionId: string; text: string; uiLanguage?: UiLanguage }
  | { type: 'config'; settings: AppSettings }
  | { type: 'setWorkingDir'; sessionId: string; path: string }
  | { type: 'setMessages'; sessionId: string; messages: Message[] }
  | { type: 'confirmResponse'; sessionId: string; toolCallId: string; confirmed: boolean }
  | { type: 'killBgProcess'; sessionId: string; pid: number }
  | { type: 'planResponse'; sessionId: string; runId: string; approved: boolean }
  | { type: 'hookConfig'; sessionId: string; hooks: HookInterface[] };

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
  | { type: 'bgProcessPortsVerified'; sessionId: string; pid: number; ports: number[] }
  | { type: 'toolProgress'; sessionId: string; toolCallId: string; output: string }
  | { type: 'runStarted'; sessionId: string; runId: string }
  | { type: 'runEvent'; sessionId: string; event: RunEvent }
  | { type: 'subagentStart'; sessionId: string; execution: SubagentExecution }
  | { type: 'subagentEnd'; sessionId: string; id: string; result: SubagentResult }
  | {
      type: 'subagentProgress';
      sessionId: string;
      executionId: string;
      agent: string;
      delta: SubagentProgressDelta;
    }
  | { type: 'goalEvent'; sessionId: string; event: GoalEvent }
  | { type: 'confirmRequest'; sessionId: string; toolCall: ToolCallContent }
  | {
      type: 'planRequest';
      sessionId: string;
      runId: string;
      planContent: string;
      planFilePath: string;
    }
  | { type: 'planStateChanged'; sessionId: string; phase: PlanPhase; planFilePath: string }
  | {
      type: 'permissionCheck';
      sessionId: string;
      toolName: string;
      params: Record<string, unknown>;
    };

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
  /** Memories referenced by this message */
  memoryReferences?: MemoryEntry[];
}

export type StreamEventType =
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'turn_start'
  | 'turn_end'
  | 'error'
  | 'system_prompt'
  | 'guidance_injected';

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
  /** Guidance text (emitted when a mid-run guidance prompt is injected). */
  text?: string;
}

// ===== Run Event Types =====

/** Per-turn LLM request message detail (CallTracePanel rendering). */
export interface RequestMessageTrace {
  role: string;
  length: number;
  preview: string;
  /** Full or capped message content actually sent to the LLM. */
  content?: string;
}

/** Per-turn LLM request/response detail (CallTracePanel rendering). */
export interface TurnDetail {
  turnNumber: number;
  systemTokens: number;
  requestMessages: RequestMessageTrace[];
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

/** Wire protocol version — bumped on breaking event schema changes. */
export const WIRE_PROTOCOL_VERSION = 1;

/** Content part types for content.part events (inspired by kimi-code LoopContentPartEvent). */
export interface TextPart {
  kind: 'text';
  text: string;
}

export interface ThinkPart {
  kind: 'thinking';
  thinking: string;
}

export type ContentPart = TextPart | ThinkPart;

/** Events recorded in the per-run JSONL event log. */
export type RunEvent =
  | { type: 'metadata'; protocol_version: number; created_at: number; timestamp?: string }
  | { type: 'run_started'; runId: RunId; timestamp: string; modelName?: string }
  | { type: 'turn.prompt'; runId: RunId; input: string; timestamp: string }
  | { type: 'turn_started'; runId: RunId; turnNumber: number; timestamp: string }
  | { type: 'stream_event'; runId: RunId; event: StreamEvent; timestamp: string }
  | {
      type: 'content.part';
      runId: RunId;
      turnNumber: number;
      part: ContentPart;
      timestamp: string;
    }
  | {
      type: 'tool_started';
      runId: RunId;
      toolCallId: string;
      toolName: string;
      timestamp: string;
      arguments?: string;
      /** Human-readable one-liner describing what the tool will do. */
      description?: string;
    }
  | {
      type: 'tool_completed';
      runId: RunId;
      toolCallId: string;
      toolName: string;
      success: boolean;
      timestamp: string;
      output?: string;
      error?: string;
      /** Whether the output was truncated (e.g. file too long, command output capped). */
      truncated?: boolean;
      /** Human-readable side note (e.g. "Read 200 lines, capped at 2000 chars"). */
      message?: string;
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
  | { type: 'guidance_injected'; runId: RunId; text: string; timestamp: string }
  | { type: 'run_recovered'; runId: RunId; reason: string; timestamp: string }
  | {
      type: 'model_request_started';
      runId: RunId;
      turnNumber: number;
      attempt: number;
      provider: string;
      model: string;
      requestKind?: 'main' | 'semantic_compact';
      timestamp: string;
    }
  | {
      type: 'model_request_completed';
      runId: RunId;
      turnNumber: number;
      attempt: number;
      provider: string;
      model: string;
      requestKind?: 'main' | 'semantic_compact';
      durationMs: number;
      /** Time to first token (ms). Measured from request start to first text/think delta. */
      firstTokenLatencyMs?: number;
      /** Time spent streaming after first token (ms). durationMs - firstTokenLatencyMs. */
      streamDurationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cacheWrite1hTokens?: number;
      inputCost?: number;
      outputCost?: number;
      cacheReadCost?: number;
      cacheWriteCost?: number;
      totalCost?: number;
      stopReason?: string;
      error?: string;
      timestamp: string;
      /** (Call trace) Message summaries sent to the LLM for this turn. */
      requestMessages?: RequestMessageTrace[];
      /** (Call trace) System prompt token count for this turn. */
      systemTokens?: number;
      /** (Call trace) The LLM's visible text response. */
      responseText?: string;
      /** (Call trace) The LLM's thinking/reasoning response. */
      responseThinking?: string;
      /** (Call trace) Tool calls the LLM requested. */
      responseToolCalls?: ToolCallContent[];
    }
  | {
      type: 'semantic_compact_started';
      runId: RunId;
      turnNumber: number;
      mode: 'shadow' | 'replace';
      beforeTokens: number;
      newlyCompletedTokens: number;
      previousProjectionId?: string;
      timestamp: string;
    }
  | {
      type: 'semantic_compact_completed';
      runId: RunId;
      turnNumber: number;
      mode: 'shadow' | 'replace';
      projectionId: string;
      previousProjectionId?: string;
      sourceDigest: string;
      beforeTokens: number;
      projectionTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      durationMs: number;
      applied: boolean;
      timestamp: string;
    }
  | {
      type: 'semantic_compact_rejected';
      runId: RunId;
      turnNumber: number;
      reason: string;
      timestamp: string;
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
  totals: { input: number; output: number; total: number; runs: number; messages: number };
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
  /** Ordered streaming trace blocks for the sub-agent's thinking and tool calls. */
  internalBlocks?: SubagentTraceBlock[];
}

export interface SubagentTraceBlock {
  id: string;
  type: 'thinking' | 'tool_call';
  thinking?: string;
  toolCall?: ToolCallContent;
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

/** Policy for snipping unreferenced tool results (zero-cost compression). */
export interface SnipPolicy {
  enabled: boolean;
  /** Tool result text longer than this (chars) is eligible for snipping. Default 500. */
  minResultChars?: number;
  /** Tool results older than this many turns are eligible for snipping. Default 3. */
  maxAgeTurns?: number;
}

/** Policy for context collapse (read-time projection, reversible). */
export interface ContextCollapsePolicy {
  enabled: boolean;
  /** Trigger collapse when estimated tokens exceed this ratio of context window. Default 0.7. */
  collapseThreshold?: number;
  /** Maximum tokens to collapse into a single summary group. Default 4096. */
  maxGroupTokens?: number;
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
  /** Unreferenced tool result snipping (zero-cost). */
  snip?: SnipPolicy;
  /** Context collapse (read-time projection). */
  contextCollapse?: ContextCollapsePolicy;
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
  snippedResults?: number;
  snippedTokensSaved?: number;
  collapsedGroups?: number;
  collapsedTokensSaved?: number;
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

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitCheckoutResult {
  success: boolean;
  branch?: string;
  error?: string;
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

// ===== Memory Types =====

export type MemoryScope = 'session' | 'project' | 'global';
export type MemoryKind =
  | 'task_summary'
  | 'project_fact'
  | 'decision'
  | 'preference'
  | 'lesson'
  | 'ephemeral';

export interface StructuredFact {
  type: 'fact' | 'preference' | 'decision';
  subject: string;
  predicate: string;
  object: string;
  validity: { start: string; end?: string };
  confidence: number;
}

export interface MemoryEntry {
  date: string;
  slug: string;
  userRequest: string;
  toolsUsed: Record<string, number>;
  summary: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  embedding?: number[];
  importance?: number;
  tags?: string[];
  accessCount?: number;
  updatedAt?: string;
  expiresAt?: string;
  validFrom?: string;
  pinned?: boolean;
  facts?: StructuredFact[];
  supersedes?: string[];
  sceneId?: string;
}
