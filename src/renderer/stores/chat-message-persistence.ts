import type { Message, ToolCallContent } from '@shared/types';

interface PersistedAssistantInput {
  visibleContent: string;
  thinking?: string;
  toolCalls?: ToolCallContent[];
  finalMessage?: Message;
}

export function buildPersistedAssistantMessage(input: PersistedAssistantInput): Message {
  const finalContent = input.finalMessage?.content;
  const content =
    finalContent && (typeof finalContent === 'string' || finalContent.length > 0)
      ? finalContent
      : buildContentBlocks(input.visibleContent, input.thinking);

  return {
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
  };
}

function buildContentBlocks(visibleContent: string, thinking?: string): Message['content'] {
  const content: Message['content'] = [];
  if (thinking) content.push({ type: 'thinking', text: thinking });
  content.push({ type: 'text', text: visibleContent || '已完成。' });
  return content;
}
