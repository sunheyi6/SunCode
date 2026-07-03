import type { UiLanguage } from '@shared/types';

export type { UiLanguage } from '@shared/types';

const CJK_RE = /[\u3400-\u9fff]/g;
const LATIN_RE = /[a-zA-Z]/g;

export function detectUiLanguage(text: string | undefined): UiLanguage {
  const value = text ?? '';
  const cjkCount = value.match(CJK_RE)?.length ?? 0;
  const latinCount = value.match(LATIN_RE)?.length ?? 0;
  return cjkCount >= Math.max(1, latinCount * 0.25) ? 'zh' : 'en';
}

export function textMatchesUiLanguage(text: string, language: UiLanguage): boolean {
  const cjkCount = text.match(CJK_RE)?.length ?? 0;
  const latinCount = text.match(LATIN_RE)?.length ?? 0;
  if (language === 'zh') return cjkCount > 0 || latinCount === 0;
  return latinCount > 0 || cjkCount === 0;
}
