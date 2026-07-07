import { sanitizeStructuredMessageLeak } from '@shared/finalization';
import type { Message, TaskPlan, ToolCallContent, TurnDetail } from '@shared/types';
import type { UiLanguage } from '../utils/ui-language';

interface PersistedAssistantInput {
  visibleContent: string;
  thinking?: string;
  toolCalls?: ToolCallContent[];
  systemPrompt?: string;
  turnDetails?: TurnDetail[];
  uiLanguage?: UiLanguage;
  finalMessage?: Message;
  /** Structured task plan accumulated across turns (from the worker). */
  taskPlan?: TaskPlan;
}

export function buildPersistedAssistantMessage(input: PersistedAssistantInput): Message {
  const finalContent = input.finalMessage?.content;
  const content =
    finalContent && (typeof finalContent === 'string' || finalContent.length > 0)
      ? sanitizeMessageContent(finalContent)
      : buildContentBlocks(input.visibleContent, input.thinking);

  // Prefer the explicitly-passed task plan; fall back to one carried on finalMessage.
  const taskPlan = input.taskPlan ?? input.finalMessage?.taskPlan;

  const message: Message = {
    role: 'assistant',
    content,
    toolCalls: input.toolCalls?.map((tc) => ({
      type: 'tool_call',
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      status: tc.status,
      result: tc.result,
      thinkingOffset: tc.thinkingOffset,
    })),
    uiLanguage: input.uiLanguage,
    // Persist system prompt so call trace panel works across session switches
    systemPrompt: input.systemPrompt,
    ...(input.turnDetails ? { turnDetails: input.turnDetails } : {}),
    ...(taskPlan ? { taskPlan } : {}),
  };

  // Deep-clone to strip Vue reactivity proxies before IPC.
  // Vue reactive objects contain internal Proxies and Symbol metadata
  // that Electron's structured clone cannot serialize.
  return JSON.parse(JSON.stringify(message)) as Message;
}

function sanitizeMessageContent(content: Message['content']): Message['content'] {
  if (typeof content === 'string') return sanitizeStructuredMessageLeak(content);
  return content.map((block) => {
    if (block.type !== 'text') return block;
    return { ...block, text: sanitizeStructuredMessageLeak(block.text) };
  });
}

function buildContentBlocks(visibleContent: string, thinking?: string): Message['content'] {
  const content: Message['content'] = [];
  if (thinking) content.push({ type: 'thinking', text: thinking });
  content.push({ type: 'text', text: visibleContent || '已完成。' });
  return content;
}
