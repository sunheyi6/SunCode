import type { ToolCallContent } from '@shared/types';

export function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function commandSummary(args: Record<string, unknown>): string {
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  if (description) return description;
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  return command.length > 80 ? `${command.slice(0, 77)}...` : command || '执行命令';
}

export function toolActionLabel(name: string): string {
  switch (name) {
    case 'bash':
      return '运行命令';
    case 'read':
      return '读取';
    case 'glob':
      return '查找';
    case 'grep':
      return '搜索';
    case 'edit':
      return '编辑';
    case 'write':
      return '写入';
    case 'subagent':
      return '子代理';
    default:
      return name;
  }
}

export function fileOperationView(call: ToolCallContent): {
  filePath: string;
  label: '编辑中' | '已编辑' | '编辑失败';
  addedLines?: number;
  removedLines?: number;
  error?: string;
} {
  const args = parseToolArguments(call.arguments);
  const details = call.result?.details?.type === 'file_edit' ? call.result.details : undefined;
  const failed = call.status === 'error' || details?.status === 'failed';
  return {
    filePath:
      details?.filePath || (typeof args.file_path === 'string' ? args.file_path : call.name),
    label: failed ? '编辑失败' : call.status === 'running' ? '编辑中' : '已编辑',
    addedLines: details?.addedLines,
    removedLines: details?.removedLines,
    error: details?.error || call.result?.error,
  };
}
