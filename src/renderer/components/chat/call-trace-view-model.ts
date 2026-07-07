import type {
  RequestMessageTrace,
  SubagentResult,
  ToolCallContent,
  TurnDetail,
} from '@shared/types';
import type { ChatMessage } from '../../stores/chat';
import { textMatchesUiLanguage, type UiLanguage } from '../../utils/ui-language';

export interface CallTraceOutline {
  systemPrompt?: {
    text: string;
    charCount: number;
  };
  entries: CallTraceEntry[];
}

export type CallTraceEntry =
  | {
      kind: 'user';
      id: string;
      content: string;
      timestamp: number;
    }
  | CallTraceTurnEntry;

export interface CallTraceTurnEntry {
  kind: 'turn';
  id: string;
  turnNumber: number;
  modelLabel: string;
  isStreaming: boolean;
  summary: CallTraceTurnSummary;
  sections: CallTraceSection[];
}

export interface CallTraceTurnSummary {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  toolCount: number;
  completedToolCount: number;
  failedToolCount: number;
}

export type CallTraceSection =
  | {
      kind: 'input';
      title: string;
      itemCount: number;
      systemTokens: number;
      requestMessages: RequestMessageTrace[];
      defaultOpen: boolean;
    }
  | {
      kind: 'thinking';
      title: string;
      text: string;
      charCount: number;
      defaultOpen: boolean;
    }
  | {
      kind: 'tools';
      title: string;
      toolCalls: ToolCallContent[];
      itemCount: number;
      defaultOpen: boolean;
    }
  | {
      kind: 'response';
      title: string;
      text: string;
      charCount: number;
      defaultOpen: boolean;
    };

export interface InlineCallTrace {
  entries: InlineCallTraceEntry[];
  toolCount: number;
  completedToolCount: number;
  failedToolCount: number;
}

export type InlineCallTraceEntry =
  | {
      kind: 'thinking';
      id: string;
      text: string;
      isCurrent: boolean;
      isActive: boolean;
    }
  | {
      kind: 'text';
      id: string;
      text: string;
      isCurrent: boolean;
      isActive: boolean;
    }
  | {
      kind: 'guidance';
      id: string;
      text: string;
      isCurrent: boolean;
      isActive: boolean;
    }
  | {
      kind: 'tools';
      id: string;
      label: string;
      toolCalls: ToolCallContent[];
      isCurrent: boolean;
      hasRunning: boolean;
      hasFailed: boolean;
      isActive: boolean;
    };

/**
 * 排序 entries：活跃 entry（运行中的工具组 / 正在追加的思考或文本）排到最后，
 * 其余按原序保留（即 blocks 数组顺序 = delta 到达时间顺序）。
 * 稳定排序：用 index 做 tiebreaker，保证多个活跃 entry 之间相对顺序不变。
 */
function sortEntriesByActiveLast(entries: InlineCallTraceEntry[]): InlineCallTraceEntry[] {
  const indexed = entries.map((entry, index) => ({ entry, index }));
  indexed.sort((a, b) => {
    if (a.entry.isActive !== b.entry.isActive) return a.entry.isActive ? 1 : -1;
    return a.index - b.index;
  });
  return indexed.map(({ entry }) => entry);
}

export function buildCallTraceOutline(input: {
  messages: ChatMessage[];
  systemPrompt: string;
}): CallTraceOutline {
  const entries: CallTraceEntry[] = [];

  for (const msg of input.messages) {
    if (msg.role === 'user') {
      entries.push({
        kind: 'user',
        id: msg.id,
        content: msg.content,
        timestamp: msg.timestamp,
      });
      continue;
    }

    if (msg.role !== 'assistant') continue;

    const turns = getTurns(msg);
    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index];
      if (turn) {
        entries.push(buildTurnEntry(msg, turn, index, turns.length));
      }
    }
  }

  return {
    systemPrompt: input.systemPrompt
      ? { text: input.systemPrompt, charCount: input.systemPrompt.length }
      : undefined,
    entries,
  };
}

function buildTurnEntry(
  msg: ChatMessage,
  turn: TurnDetail,
  index: number,
  turnCount: number,
): CallTraceTurnEntry {
  const executedToolCalls = matchExecutedToolCalls(turn.response.toolCalls, msg.toolCalls ?? []);
  const raw = turn as unknown as Record<string, unknown>;
  const provider = typeof raw.provider === 'string' ? raw.provider : '';
  const model = typeof raw.model === 'string' ? raw.model : '';
  const toolCount = executedToolCalls.length;
  const failedToolCount = executedToolCalls.filter(
    (toolCall) => toolCall.status === 'error' || toolCall.result?.success === false,
  ).length;
  const completedToolCount = executedToolCalls.filter(
    (toolCall) => toolCall.status === 'done' || toolCall.result,
  ).length;

  return {
    kind: 'turn',
    id: `${msg.id}:turn:${turn.turnNumber}:${index}`,
    turnNumber: turn.turnNumber,
    modelLabel: provider && model ? `${provider}/${model}` : '',
    isStreaming: Boolean(msg.isStreaming && index === turnCount - 1),
    summary: {
      durationMs: turn.response.durationMs,
      inputTokens: turn.response.inputTokens,
      outputTokens: turn.response.outputTokens,
      stopReason: turn.response.stopReason,
      toolCount,
      completedToolCount,
      failedToolCount,
    },
    sections: buildSections(turn, executedToolCalls),
  };
}

function buildSections(turn: TurnDetail, toolCalls: ToolCallContent[]): CallTraceSection[] {
  const sections: CallTraceSection[] = [
    {
      kind: 'input',
      title: `输入 · ${turn.requestMessages.length} 条消息`,
      itemCount: turn.requestMessages.length,
      systemTokens: turn.systemTokens,
      requestMessages: turn.requestMessages,
      defaultOpen: false,
    },
  ];

  if (turn.response.thinking) {
    sections.push({
      kind: 'thinking',
      title: '思考',
      text: turn.response.thinking,
      charCount: turn.response.thinking.length,
      defaultOpen: false,
    });
  }

  if (toolCalls.length > 0) {
    const hasRunningTool = toolCalls.some((toolCall) => toolCall.status === 'running');
    sections.push({
      kind: 'tools',
      title: `工具 · ${toolCalls.length} 个`,
      toolCalls,
      itemCount: toolCalls.length,
      defaultOpen: hasRunningTool,
    });
  }

  if (turn.response.text) {
    sections.push({
      kind: 'response',
      title: `输出 · ${turn.response.text.length} 字符`,
      text: turn.response.text,
      charCount: turn.response.text.length,
      defaultOpen: false,
    });
  }

  return sections;
}

function getTurns(msg: ChatMessage): TurnDetail[] {
  if (msg.turnDetails && msg.turnDetails.length > 0) return msg.turnDetails;
  if (msg.thinking || msg.content || (msg.toolCalls && msg.toolCalls.length > 0)) {
    return [
      {
        turnNumber: msg.turnCount ?? 1,
        systemTokens: 0,
        requestMessages: [
          { role: 'user', length: msg.content.length, preview: msg.content.slice(0, 200) },
        ],
        response: {
          text: msg.content,
          thinking: msg.thinking || '',
          toolCalls: msg.toolCalls ?? [],
        },
      },
    ];
  }
  return [];
}

function matchExecutedToolCalls(
  modelToolCalls: ToolCallContent[],
  executedToolCalls: ToolCallContent[],
): ToolCallContent[] {
  return modelToolCalls.map(
    (modelToolCall) =>
      executedToolCalls.find((toolCall) => toolCall.id === modelToolCall.id) ?? modelToolCall,
  );
}

export function buildInlineCallTrace(message: ChatMessage): InlineCallTrace {
  const uiLanguage = message.uiLanguage ?? 'zh';
  const entries: InlineCallTraceEntry[] = [];
  const representedToolIds = new Set<string>();
  const blocks = message.blocks ?? [];
  const hasBlocks = blocks.length > 0;

  // 流式态下，末尾连续同类型的 block 视为"活跃"（正在追加 delta）。
  // 例如 blocks=[text, tool, thinking, thinking] 末尾的 thinking 活跃；
  // blocks=[text, tool] 末尾的 tool 活跃（若是 running）。
  const activeBlockIds = new Set<string>();
  if (message.isStreaming && blocks.length > 0) {
    let lastType = blocks[blocks.length - 1]?.type;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (!b) break;
      if (b.type !== lastType) break;
      activeBlockIds.add(b.id);
      lastType = b.type;
    }
  }

  for (const block of blocks) {
    if (block.type === 'thinking' && block.thinking) {
      const thinkingText = displayThinkingText(block.thinking, uiLanguage, message.isStreaming);
      if (thinkingText) {
        entries.push({
          kind: 'thinking',
          id: block.id,
          text: thinkingText,
          isCurrent: false,
          isActive: activeBlockIds.has(block.id),
        });
      }
      continue;
    }

    if (block.type === 'text' && block.text) {
      entries.push({
        kind: 'text',
        id: block.id,
        text: block.text,
        isCurrent: false,
        isActive: activeBlockIds.has(block.id),
      });
      continue;
    }

    if (block.type === 'guidance' && block.text) {
      entries.push({
        kind: 'guidance',
        id: block.id,
        text: block.text,
        isCurrent: false,
        isActive: false,
      });
      continue;
    }

    if (block.type === 'tool_call' && block.toolCall) {
      const latestToolCall =
        message.toolCalls?.find((toolCall) => toolCall.id === block.toolCall?.id) ?? block.toolCall;
      representedToolIds.add(latestToolCall.id);
      pushToolGroup(entries, [latestToolCall], block.id, uiLanguage, message.isStreaming);
    }
  }

  if (!hasBlocks && message.thinking) {
    const thinkingText = displayThinkingText(message.thinking, uiLanguage, message.isStreaming);
    if (thinkingText) {
      entries.push({
        kind: 'thinking',
        id: `${message.id}:thinking`,
        text: thinkingText,
        isCurrent: false,
        isActive: message.isStreaming,
      });
    }
  }

  const unrepresentedToolCalls = (message.toolCalls ?? []).filter(
    (toolCall) => !representedToolIds.has(toolCall.id),
  );
  pushToolGroups(
    entries,
    unrepresentedToolCalls,
    `${message.id}:tools`,
    uiLanguage,
    message.isStreaming,
  );

  // tools entry 的 isActive 由 hasRunning 决定（pushToolGroup/buildToolEntry 设置）
  const orderedEntries = sortEntriesByActiveLast(entries);

  const lastIndex = orderedEntries.length - 1;
  const markedEntries = orderedEntries.map((entry, index) => ({
    ...entry,
    isCurrent: message.isStreaming && index === lastIndex,
  }));

  const toolCalls = message.toolCalls ?? [];
  return {
    entries: markedEntries,
    toolCount: toolCalls.length,
    completedToolCount: toolCalls.filter(
      (toolCall) => toolCall.status === 'done' || toolCall.result,
    ).length,
    failedToolCount: toolCalls.filter(
      (toolCall) => toolCall.status === 'error' || toolCall.result?.success === false,
    ).length,
  };
}

export function buildSubagentInlineTrace(
  result: SubagentResult,
  isStreaming: boolean,
  uiLanguage: UiLanguage = 'zh',
): InlineCallTrace {
  const entries: InlineCallTraceEntry[] = [];
  const representedToolIds = new Set<string>();
  const blocks = result.internalBlocks ?? [];
  const hasBlocks = blocks.length > 0;

  // 流式态下，末尾连续同类型的 block 视为"活跃"。
  const activeBlockIds = new Set<string>();
  if (isStreaming && blocks.length > 0) {
    let lastType = blocks[blocks.length - 1]?.type;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (!b) break;
      if (b.type !== lastType) break;
      activeBlockIds.add(b.id);
      lastType = b.type;
    }
  }

  for (const block of blocks) {
    if (block.type === 'thinking' && block.thinking) {
      const thinkingText = displayThinkingText(block.thinking, uiLanguage, isStreaming);
      if (thinkingText) {
        entries.push({
          kind: 'thinking',
          id: block.id,
          text: thinkingText,
          isCurrent: false,
          isActive: activeBlockIds.has(block.id),
        });
      }
      continue;
    }

    if (block.type === 'tool_call' && block.toolCall) {
      const latestToolCall =
        result.internalCalls?.find((toolCall) => toolCall.id === block.toolCall?.id) ??
        block.toolCall;
      representedToolIds.add(latestToolCall.id);
      pushToolGroup(entries, [latestToolCall], block.id, uiLanguage, isStreaming);
    }
  }

  if (!hasBlocks && result.thinking) {
    const thinkingText = displayThinkingText(result.thinking, uiLanguage, isStreaming);
    if (thinkingText) {
      entries.push({
        kind: 'thinking',
        id: `${result.agent}:thinking`,
        text: thinkingText,
        isCurrent: false,
        isActive: isStreaming,
      });
    }
  }

  const unrepresentedToolCalls = (result.internalCalls ?? []).filter(
    (toolCall) => !representedToolIds.has(toolCall.id),
  );
  pushToolGroups(entries, unrepresentedToolCalls, `${result.agent}:tools`, uiLanguage, isStreaming);

  const orderedEntries = sortEntriesByActiveLast(entries);

  const lastIndex = orderedEntries.length - 1;
  const markedEntries = orderedEntries.map((entry, index) => ({
    ...entry,
    isCurrent: isStreaming && index === lastIndex,
  }));

  const toolCalls = result.internalCalls ?? [];
  return {
    entries: markedEntries,
    toolCount: toolCalls.length,
    completedToolCount: toolCalls.filter(
      (toolCall) => toolCall.status === 'done' || toolCall.result,
    ).length,
    failedToolCount: toolCalls.filter(
      (toolCall) => toolCall.status === 'error' || toolCall.result?.success === false,
    ).length,
  };
}

function pushToolGroup(
  entries: InlineCallTraceEntry[],
  toolCalls: ToolCallContent[],
  fallbackId: string,
  language: UiLanguage,
  isStreaming = false,
): void {
  if (toolCalls.length === 0) return;
  const previous = entries[entries.length - 1];
  if (previous?.kind === 'tools' && canMergeToolGroups(previous.toolCalls, toolCalls)) {
    const mergedToolCalls = [...previous.toolCalls, ...toolCalls];
    entries[entries.length - 1] = buildToolEntry(mergedToolCalls, previous.id, language);
    return;
  }

  entries.push(buildToolEntry(toolCalls, fallbackId, language));
}

function pushToolGroups(
  entries: InlineCallTraceEntry[],
  toolCalls: ToolCallContent[],
  fallbackId: string,
  language: UiLanguage,
  isStreaming = false,
): void {
  let groupIndex = 0;
  let group: ToolCallContent[] = [];

  for (const toolCall of toolCalls) {
    const previous = group[group.length - 1];
    if (previous && toolGroupKind(previous) !== toolGroupKind(toolCall)) {
      pushToolGroup(entries, group, `${fallbackId}:${groupIndex}`, language, isStreaming);
      groupIndex += 1;
      group = [];
    }
    group.push(toolCall);
  }

  if (group.length > 0) {
    pushToolGroup(entries, group, `${fallbackId}:${groupIndex}`, language, isStreaming);
  }
}

function canMergeToolGroups(previous: ToolCallContent[], next: ToolCallContent[]): boolean {
  if (previous.length === 0 || next.length === 0) return false;
  const nextKind = toolGroupKind(next[0]);
  return previous.every((toolCall) => toolGroupKind(toolCall) === nextKind);
}

function buildToolEntry(
  toolCalls: ToolCallContent[],
  id: string,
  language: UiLanguage,
): InlineCallTraceEntry {
  const hasRunning = toolCalls.some((toolCall) => toolCall.status === 'running');
  const hasFailed = toolCalls.some(
    (toolCall) => toolCall.status === 'error' || toolCall.result?.success === false,
  );

  return {
    kind: 'tools',
    id,
    label: inlineToolLabel(toolCalls, hasRunning, hasFailed, language),
    toolCalls,
    isCurrent: false,
    hasRunning,
    hasFailed,
    isActive: hasRunning,
  };
}

function inlineToolLabel(
  toolCalls: ToolCallContent[],
  hasRunning: boolean,
  hasFailed: boolean,
  language: UiLanguage,
): string {
  const mixedResultLabel = inlineMixedResultLabel(toolCalls, hasRunning, language);
  if (mixedResultLabel) return mixedResultLabel;

  const status = localizedStatus(hasRunning, hasFailed, language);
  if (toolCalls.length > 1) {
    return formatCount(status, toolCalls.length, toolGroupKind(toolCalls[0]), language);
  }

  const toolCall = toolCalls[0];
  if (!toolCall) return status;
  return formatCount(status, 1, toolGroupKind(toolCall), language);
}

function inlineMixedResultLabel(
  toolCalls: ToolCallContent[],
  hasRunning: boolean,
  language: UiLanguage,
): string | undefined {
  if (hasRunning || toolCalls.length <= 1) return undefined;

  const succeeded = toolCalls.filter(isSuccessfulToolCall).length;
  const failed = toolCalls.filter(isFailedToolCall).length;
  if (succeeded === 0 || failed === 0) return undefined;

  const totalLabel = formatCount(
    localizedStatus(false, false, language),
    toolCalls.length,
    toolGroupKind(toolCalls[0]),
    language,
  );
  if (language === 'en') {
    return `${totalLabel}, ${succeeded} succeeded, ${failed} failed`;
  }
  return `${totalLabel}，成功 ${succeeded}，失败 ${failed}`;
}

function isSuccessfulToolCall(toolCall: ToolCallContent): boolean {
  if (toolCall.status === 'error' || toolCall.result?.success === false) return false;
  return toolCall.status === 'done' || toolCall.result?.success === true;
}

function isFailedToolCall(toolCall: ToolCallContent): boolean {
  return toolCall.status === 'error' || toolCall.result?.success === false;
}

function toolGroupKind(toolCall: ToolCallContent | undefined): 'command' | 'agent' | 'tool' {
  if (toolCall?.name === 'bash') return 'command';
  if (toolCall?.name === 'subagent') return 'agent';
  return 'tool';
}

function formatCount(
  status: string,
  count: number,
  kind: 'command' | 'agent' | 'tool',
  language: UiLanguage,
): string {
  if (language === 'en') {
    const unit =
      kind === 'command'
        ? count === 1
          ? 'command'
          : 'commands'
        : kind === 'agent'
          ? count === 1
            ? 'agent'
            : 'agents'
          : count === 1
            ? 'tool'
            : 'tools';
    return `${status} ${count} ${unit}`;
  }

  const unit = kind === 'command' ? '条命令' : kind === 'agent' ? '个代理' : '个工具';
  return `${status} ${count} ${unit}`;
}

function displayThinkingText(
  text: string,
  language: UiLanguage,
  isStreaming = false,
): string | undefined {
  // 流式态下不按 UI 语言过滤：模型常用英文思考、用 UI 语言回复，
  // 过滤会让用户在等待响应时看到完全空白的聊天框。
  // 语言过滤只用于最终态调用追踪的整洁展示。
  if (isStreaming) return text;
  if (textMatchesUiLanguage(text, language)) return text;
  return undefined;
}

function localizedStatus(hasRunning: boolean, hasFailed: boolean, language: UiLanguage): string {
  if (language === 'en') {
    if (hasRunning) return 'Running';
    if (hasFailed) return 'Failed';
    return 'Ran';
  }
  if (hasRunning) return '正在运行';
  if (hasFailed) return '运行失败';
  return '已运行';
}
