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
