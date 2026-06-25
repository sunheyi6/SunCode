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
