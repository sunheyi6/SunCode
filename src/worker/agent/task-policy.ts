import type { AppSettings } from '@shared/types';

export const SIMPLE_TASK_MAX_TURNS = 30;

const SIMPLE_TASK_SIGNALS =
  /(颜色|色值|文案|文字|间距|边距|按钮|图标|样式|标题|对齐|重命名|改名|替换|color|copy|spacing|margin|button|icon|style|css|title|align|rename)/i;
const COMPLEX_TASK_SIGNALS =
  /(架构|并发|竞态|死锁|崩溃|性能|安全|迁移|重构|内存泄漏|数据丢失|根因分析|发布|部署|architecture|concurr|race|deadlock|crash|performance|security|migration|refactor|memory leak|data loss|root cause|release|deploy)/i;

/** Conservative classifier: only short, explicit surface-level edits are treated as simple. */
export function isSimpleTask(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized || normalized.length > 240) return false;
  if (COMPLEX_TASK_SIGNALS.test(normalized)) return false;
  return SIMPLE_TASK_SIGNALS.test(normalized);
}

export function applyOrdinaryTaskPolicy(settings: AppSettings, prompt: string): AppSettings {
  if (!isSimpleTask(prompt)) return settings;

  return {
    ...settings,
    maxTurns: Math.min(settings.maxTurns, SIMPLE_TASK_MAX_TURNS),
    thinkingLevel: settings.thinkingLevel === 'xhigh' ? 'medium' : settings.thinkingLevel,
  };
}
