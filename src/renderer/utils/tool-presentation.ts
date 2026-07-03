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

export function inferToolOutputLanguage(command: string | undefined, output: string): string {
  const pathLanguage = command && !/\s/.test(command.trim()) ? inferPathLanguage(command) : '';
  if (pathLanguage) return pathLanguage;
  const commandLanguage = command ? inferCommandLanguage(command) : '';
  const contentLanguage = inferContentLanguage(output);
  return contentLanguage || commandLanguage || 'text';
}

export function formatToolOutputAsMarkdown(command: string | undefined, output: string): string {
  const language = inferToolOutputLanguage(command, output);
  const escaped = output.replace(/```/g, '``\u200b`');
  return `\`\`\`${language}\n${escaped}\n\`\`\``;
}

function inferCommandLanguage(command: string): string {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return '';

  if (
    /\b(pwsh|powershell)(\.exe)?\b/.test(normalized) ||
    /^(get|set|new|remove|invoke|start|stop|select|where|write|read)-[a-z]/.test(normalized)
  ) {
    return 'powershell';
  }

  if (
    /\bcmd(\.exe)?\s*\/[ck]\b/.test(normalized) ||
    /^(dir|copy|xcopy|robocopy|del|erase|type|findstr|cls|assoc|ftype)\b/.test(normalized)
  ) {
    return 'cmd';
  }

  if (
    /^(bash|sh|zsh|fish)\b/.test(normalized) ||
    /^(ls|cat|grep|sed|awk|find|chmod|chown|rm|cp|mv|tar|curl|wget|git|bun|npm|pnpm|yarn)\b/.test(
      normalized,
    )
  ) {
    return 'bash';
  }

  return '';
}

function inferPathLanguage(path: string): string {
  const normalized = path.trim().toLowerCase();
  const base = normalized.split(/[/\\]/).pop() || normalized;
  const ext = base.includes('.') ? base.split('.').pop() || '' : base;
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    vue: 'vue',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    md: 'markdown',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    bat: 'cmd',
    cmd: 'cmd',
    sql: 'sql',
    graphql: 'graphql',
    toml: 'toml',
    ini: 'ini',
    cfg: 'ini',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
  };
  return map[base] || map[ext] || '';
}

function inferContentLanguage(output: string): string {
  const text = output.trim();
  if (!text) return 'text';

  if (isJson(text)) return 'json';
  if (/^diff --git\b|^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/m.test(text)) return 'diff';
  if (/^<\?xml\b|<\/?[a-z][\s\S]*>/i.test(text) && /<\/[a-z][\s\S]*>/i.test(text)) {
    return /<(html|body|div|span|template|script|style)\b/i.test(text) ? 'html' : 'xml';
  }
  if (/^\s*(select|insert|update|delete|create|alter|drop)\b[\s\S]*;?\s*$/i.test(text)) {
    return 'sql';
  }
  if (/\b(def|class)\s+[a-zA-Z_]\w*\s*(\(|:)|^\s*from\s+\S+\s+import\s+/m.test(text)) {
    return 'python';
  }
  if (/\b(fn|let|mut|impl|use)\s+[a-zA-Z_]\w*|println!\s*\(/.test(text)) return 'rust';
  if (/\bpackage\s+main\b|\bfunc\s+[a-zA-Z_]\w*\s*\(/.test(text)) return 'go';
  if (/\binterface\s+\w+|\btype\s+\w+\s*=|:\s*(string|number|boolean)\b/.test(text)) {
    return 'typescript';
  }
  if (/\b(const|let|var|function|export|import)\b|=>/.test(text)) return 'javascript';
  if (/^[\w.-]+\s*:\s*.+$/m.test(text) && /^[-\w.]+:\s/m.test(text)) return 'yaml';
  if (/^[.#]?[a-zA-Z][\w-]*\s*\{[\s\S]*\}/.test(text)) return 'css';

  return '';
}

function isJson(text: string): boolean {
  if (!/^[{[]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
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
