import type { ToolCallContent, TurnDetail } from '@shared/types';
import type { ChatMessage } from '../../stores/chat';

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
      requestMessages: Array<{ role: string; length: number; preview: string }>;
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
      title: `思考 · ${turn.response.thinking.length} 字符`,
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
      title: `回复 · ${turn.response.text.length} 字符`,
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
