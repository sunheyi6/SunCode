const INCOMPLETE_PROGRESS_PATTERNS = [
  /现在我需要/,
  /接下来我(?:需要|会|来)/,
  /让我(?:查看|检查|修复|重新|继续)/,
  /我(?:需要|还需要|会|来)(?:先)?(?:查看|检查|修复|添加|重跑|重新运行|继续)/,
  /修复.+重新运行/,
  /添加.+支持.+重跑/,
  /(?:设置|修复|添加|调整|改完|完成后).{0,40}(?:再运行|重跑|重新运行|重新执行)[:：]?$/,
  /(?:我直接|我会|我来|接下来).{0,80}(?:重写|修复|改写|查看|检查|运行|执行).{0,80}[:：]$/,
  /(?:有问题|失败|报错).{0,100}(?:重写|修复|改写|查看|检查|运行|执行).{0,80}[:：]$/,
  /(?:再运行|重跑|重新运行|重新执行)[:：]?$/,
  /还需要[:：]?/,
  /then rerun/i,
  /need to (?:fix|add|check|rerun|continue)/i,
];

export function isIncompleteProgressText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;

  const hasCompletionEvidence =
    /最终结果|验证[:：]|测试通过|运行通过|完成[:：]|已完成|All tests pass|pass(ed)?/i.test(
      normalized,
    );
  if (hasCompletionEvidence) return false;

  if (normalized.length < 200 && /[:：]$/.test(normalized)) return true;

  return INCOMPLETE_PROGRESS_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function sanitizeStructuredMessageLeak(text: string): string {
  if (!text.includes('"suncode.message"')) return text;

  const leakStart = findStructuredMessageStart(text);
  if (leakStart < 0) return text;

  const prefix = text.slice(0, leakStart);
  const candidate = text.slice(leakStart).trim();
  const parsedText = parseStructuredMessageText(candidate) ?? extractStructuredMessageText(candidate);
  if (parsedText === undefined) return text;

  return `${prefix}${parsedText}`.trim();
}

function findStructuredMessageStart(text: string): number {
  const typeIndex = text.indexOf('"suncode.message"');
  if (typeIndex < 0) return -1;

  const braceIndex = text.lastIndexOf('{', typeIndex);
  return braceIndex;
}

function parseStructuredMessageText(candidate: string): string | undefined {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!isRecord(parsed) || parsed.type !== 'suncode.message') return undefined;

    const content = parsed.content;
    if (!isRecord(content) || typeof content.text !== 'string') return '';
    return content.text;
  } catch {
    return undefined;
  }
}

function extractStructuredMessageText(candidate: string): string | undefined {
  const match = candidate.match(
    /"content"\s*:\s*\{[\s\S]*?"text"\s*:\s*"((?:\\.|[^"\\])*)"/,
  );
  if (!match) return undefined;

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
