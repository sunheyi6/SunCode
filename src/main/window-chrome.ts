import type { BrowserWindow } from 'electron';
import { nativeTheme } from 'electron';

export type WindowChromeColors = {
  background: string;
  foreground: string;
};

/** User-selected global background override for native window chrome. */
let customChrome: WindowChromeColors | null = null;

export function getThemeWindowChromeColors(): WindowChromeColors {
  return nativeTheme.shouldUseDarkColors
    ? { background: '#1c1c1e', foreground: '#98989d' }
    : { background: '#ececf0', foreground: '#aeaeb2' };
}

export function setCustomWindowChrome(colors: WindowChromeColors | null): void {
  customChrome = colors;
}

export function resolveWindowChromeColors(): WindowChromeColors {
  return customChrome ?? getThemeWindowChromeColors();
}

/** Apply current chrome colors to a BrowserWindow (title bar buttons + window bg). */
export function applyWindowChrome(win: BrowserWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  const colors = resolveWindowChromeColors();
  win.setBackgroundColor(colors.background);
  // Windows/Linux: colors the minimize / maximize / close button strip.
  // macOS: mostly no-op for traffic lights but still safe.
  win.setTitleBarOverlay({
    color: colors.background,
    symbolColor: colors.foreground,
  });
}
