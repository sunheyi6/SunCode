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
  const parsedText =
    parseStructuredMessageText(candidate) ?? extractStructuredMessageText(candidate);
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
  const match = candidate.match(/"content"\s*:\s*\{[\s\S]*?"text"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) return extractLooseStructuredMessageText(candidate);

  try {
    const parsed = JSON.parse(`"${match[1]}"`) as string;
    const loose = extractLooseStructuredMessageText(candidate);
    return loose && loose.length > parsed.length ? loose : parsed;
  } catch {
    const fallback = match[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
    const loose = extractLooseStructuredMessageText(candidate);
    return loose && loose.length > fallback.length ? loose : fallback;
  }
}

function extractLooseStructuredMessageText(candidate: string): string | undefined {
  const marker = /"content"\s*:\s*\{[\s\S]*?"text"\s*:\s*"/.exec(candidate);
  if (!marker || marker.index === undefined) return undefined;

  const start = marker.index + marker[0].length;
  const end = findLooseStructuredMessageTextEnd(candidate, start);
  if (end <= start) return undefined;

  return candidate
    .slice(start, end)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

function findLooseStructuredMessageTextEnd(candidate: string, start: number): number {
  // Search forward from `start` for the FIRST structural closing, not the last
  // (lastIndexOf would over-match and swallow trailing junk; returning the
  // string length when nothing matches is even worse). -1 means "no loose end
  // found" — callers fall back to the strict regex result.
  let earliest = -1;
  for (const suffix of ['"}}', '"}\n}', '"}\r\n}', '"}']) {
    const index = candidate.indexOf(suffix, start);
    if (index >= start && (earliest === -1 || index < earliest)) {
      earliest = index;
    }
  }
  return earliest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
