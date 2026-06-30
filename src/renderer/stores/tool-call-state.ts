import type { ToolCallContent, ToolResult } from '@shared/types';

export function startToolCall(calls: ToolCallContent[], incoming: ToolCallContent): void {
  const existing = calls.find((call) => call.id === incoming.id);
  if (existing) {
    existing.name = incoming.name;
    existing.arguments = incoming.arguments;
    existing.status = 'running';
    return;
  }
  calls.push({ ...incoming, status: 'running' });
}

export function completeToolCall(calls: ToolCallContent[], result: ToolResult): void {
  const existing = calls.find((call) => call.id === result.toolCallId);
  if (!existing) {
    calls.push({
      type: 'tool_call',
      id: result.toolCallId,
      name: result.name,
      arguments: '',
      status: result.success ? 'done' : 'error',
      result,
    });
    return;
  }
  existing.status = result.success ? 'done' : 'error';
  existing.result = result;
}

export function mergeStreamedToolCalls(
  existing: ToolCallContent[],
  incoming: ToolCallContent[],
): ToolCallContent[] {
  const merged = [...existing];

  for (const streamed of incoming) {
    const idx = merged.findIndex((call) => call.id === streamed.id);
    if (idx >= 0) {
      merged[idx] = {
        ...streamed,
        status: merged[idx].status,
        result: merged[idx].result,
        partialOutput: merged[idx].partialOutput,
      };
    } else {
      merged.push(streamed);
    }
  }

  return merged;
}
