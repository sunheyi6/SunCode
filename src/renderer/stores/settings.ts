import type { AppearanceStyle, AppSettings } from '@shared/types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { bridge } from '../api/bridge';

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({
    activeModel: 'claude-sonnet-4-5',
    activeProvider: 'anthropic',
    thinkingLevel: 'low',
    maxTurns: 200,
    autoCompact: true,
    compactThreshold: 0.7,
    semanticCompactMode: 'off',
    semanticCompactThreshold: 0.5,
    semanticCompactMinNewTokens: 4096,
    semanticCompactMaxOutputTokens: 4096,
    theme: 'system',
    appearance: 'apple',
    permissionMode: 'full_access',
    windowsShell: 'auto',
    fontSize: 14,
    mcpServers: [],
    skills: [],
    disabledSkills: [],
    envApiKeys: {},
    customEndpoints: [],
    maxLessons: 200,
    taskCompleteNotification: 'never',
    createGitWorktree: false,
    showThinking: true,
  });

  const isLoaded = ref(false);

  /** Tracks the currently resolved theme ('light' | 'dark') for reactive use by components. */
  const resolvedTheme = ref<'light' | 'dark'>(
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );

  async function load(): Promise<AppSettings> {
    try {
      const s = await bridge.getSettings();
      settings.value = { ...settings.value, ...s };
      const resolved = await syncNativeTheme(settings.value.theme);
      applyTheme(settings.value.theme, resolved);
      applyAppearance(settings.value.appearance ?? 'apple');
      applyFontSize(settings.value.fontSize);
      applyBackgroundColor(settings.value.backgroundColor);
      isLoaded.value = true;
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
    return settings.value;
  }

  async function update(partial: Partial<AppSettings>): Promise<void> {
    try {
      const updated = await bridge.updateSettings(partial);
      settings.value = updated;
      if ('backgroundColor' in partial) {
        applyBackgroundColor(updated.backgroundColor);
      }
    } catch (error) {
      console.error('Failed to update settings:', error);
    }
  }

  function resolveTheme(theme: AppSettings['theme']): 'light' | 'dark' {
    if (theme !== 'system') return theme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  async function syncNativeTheme(theme: AppSettings['theme']): Promise<'light' | 'dark'> {
    try {
      return await bridge.setTheme(theme);
    } catch (error) {
      console.error('Failed to sync native theme:', error);
      return resolveTheme(theme);
    }
  }

  function applyTheme(theme: AppSettings['theme'], resolved = resolveTheme(theme)): void {
    document.documentElement.setAttribute('data-theme', resolved);
    resolvedTheme.value = resolved;
    // Theme tokens change via CSS; re-apply custom bg so it still overrides.
    applyBackgroundColor(settings.value.backgroundColor);
  }

  function setTheme(theme: AppSettings['theme']): void {
    settings.value = { ...settings.value, theme };
    if (theme !== 'system') applyTheme(theme);
    void update({ theme });
    void syncNativeTheme(theme).then((resolved) => applyTheme(theme, resolved));
  }

  /**
   * Apply the design style by toggling the `data-style` attribute on <html>.
   * 'apple' (the default) removes the attribute so the base :root palette is used.
   */
  function applyAppearance(style: AppearanceStyle = 'apple'): void {
    const root = document.documentElement;
    if (!style || style === 'apple') {
      root.removeAttribute('data-style');
    } else {
      root.setAttribute('data-style', style);
    }
  }

  function setAppearance(style: AppearanceStyle): void {
    settings.value = { ...settings.value, appearance: style };
    applyAppearance(style);
    void update({ appearance: style });
  }

  function applyFontSize(size: number): void {
    // Only affects chat panel via --chat-zoom (zoom ratio relative to default 14px)
    document.documentElement.style.setProperty('--chat-zoom', String(size / 14));
  }

  function setFontSize(size: number): void {
    // Update local state immediately so Vue reactivity kicks in right away
    settings.value = { ...settings.value, fontSize: size };
    applyFontSize(size);
    // Persist in background (fire-and-forget)
    update({ fontSize: size });
  }

  /** Normalize to #RRGGBB uppercase, or undefined if invalid/empty. */
  function normalizeBackgroundColor(color: string | undefined): string | undefined {
    if (!color) return undefined;
    const trimmed = color.trim();
    if (!trimmed) return undefined;
    const short = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
    if (short) {
      const [r, g, b] = short[1];
      return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
    }
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
      return trimmed.toUpperCase();
    }
    return undefined;
  }

  /**
   * Chrome/layout tokens that should share the same global background.
   * Surface/hover tokens get a slight lift so cards remain readable.
   * Text/border tokens are also overridden so light custom backgrounds
   * don't leave dark-theme white text (which looks like a blank white screen).
   */
  const GLOBAL_BG_TOKENS = [
    '--color-bg',
    '--color-bg-secondary',
    '--sidebar-bg',
    '--sidebar-panel-bg',
  ] as const;

  const GLOBAL_ELEVATED_TOKENS = [
    '--color-bg-tertiary',
    '--color-surface',
    '--color-surface-hover',
    '--color-overlay',
    '--sidebar-surface',
    '--sidebar-hover',
    '--sidebar-active',
    '--sidebar-panel-surface',
    '--sidebar-panel-hover',
    '--sidebar-panel-active',
  ] as const;

  const GLOBAL_FG_TOKENS = [
    '--color-text',
    '--color-text-secondary',
    '--color-text-muted',
    '--border-color',
    '--border-color-strong',
    '--sidebar-text',
    '--sidebar-text-secondary',
    '--sidebar-text-muted',
    '--sidebar-line',
    '--sidebar-panel-text',
    '--sidebar-panel-secondary',
    '--sidebar-panel-muted',
    '--sidebar-panel-line',
  ] as const;

  function luminanceFromHex(hex: string): number {
    const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
    const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
    const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
    // Relative luminance approximation (sRGB, linear-ish).
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function clearBackgroundOverrides(root: HTMLElement): void {
    for (const token of GLOBAL_BG_TOKENS) root.style.removeProperty(token);
    for (const token of GLOBAL_ELEVATED_TOKENS) root.style.removeProperty(token);
    for (const token of GLOBAL_FG_TOKENS) root.style.removeProperty(token);
  }

  function syncWindowChrome(color: string | undefined): void {
    try {
      const normalized = normalizeBackgroundColor(color);
      if (!normalized) {
        bridge.setChromeColors(null);
        return;
      }
      const isDarkBg = luminanceFromHex(normalized) < 0.45;
      bridge.setChromeColors({
        background: normalized,
        // Match title-bar min/max/close symbols to background luminance.
        foreground: isDarkBg ? '#c7c7cc' : '#636366',
      });
    } catch (error) {
      console.error('Failed to sync window chrome colors:', error);
    }
  }

  function applyBackgroundColor(color: string | undefined): void {
    const root = document.documentElement;
    const normalized = normalizeBackgroundColor(color);

    if (!normalized) {
      clearBackgroundOverrides(root);
      syncWindowChrome(undefined);
      return;
    }

    // Same base color across window / sidebar / settings chrome.
    for (const token of GLOBAL_BG_TOKENS) {
      root.style.setProperty(token, normalized);
    }

    // Keep native window control strip in sync with the global background.
    syncWindowChrome(normalized);

    // Derive readable surfaces + text from background luminance.
    // Critical: without FG override, a light custom bg under dark theme
    // keeps white text and appears as a blank white screen.
    const isDarkBg = luminanceFromHex(normalized) < 0.45;
    const mixTarget = isDarkBg ? '#ffffff' : '#000000';

    root.style.setProperty(
      '--color-bg-tertiary',
      `color-mix(in srgb, ${normalized} 82%, ${mixTarget})`,
    );
    root.style.setProperty(
      '--color-surface',
      `color-mix(in srgb, ${normalized} 88%, ${mixTarget})`,
    );
    root.style.setProperty(
      '--color-surface-hover',
      `color-mix(in srgb, ${normalized} 78%, ${mixTarget})`,
    );
    root.style.setProperty(
      '--color-overlay',
      `color-mix(in srgb, ${normalized} 70%, ${mixTarget})`,
    );
    root.style.setProperty(
      '--sidebar-surface',
      `color-mix(in srgb, ${normalized} 88%, ${mixTarget})`,
    );
    root.style.setProperty(
      '--sidebar-hover',
      `color-mix(in srgb, ${normalized} 78%, ${mixTarget})`,
    );
    root.style.setProperty(
      '--sidebar-active',
      `color-mix(in srgb, ${normalized} 74%, ${mixTarget})`,
    );
    root.style.setProperty(
      '--sidebar-panel-surface',
      `color-mix(in srgb, ${normalized} 88%, ${mixTarget})`,
    );
    root.style.setProperty(
      '--sidebar-panel-hover',
      `color-mix(in srgb, ${normalized} 78%, ${mixTarget})`,
    );
    root.style.setProperty(
      '--sidebar-panel-active',
      `color-mix(in srgb, ${normalized} 74%, ${mixTarget})`,
    );

    if (isDarkBg) {
      root.style.setProperty('--color-text', '#ffffff');
      root.style.setProperty('--color-text-secondary', '#98989d');
      root.style.setProperty('--color-text-muted', '#636366');
      root.style.setProperty('--border-color', 'rgba(84, 84, 88, 0.36)');
      root.style.setProperty('--border-color-strong', 'rgba(84, 84, 88, 0.6)');
      root.style.setProperty('--sidebar-text', '#ffffff');
      root.style.setProperty('--sidebar-text-secondary', '#98989d');
      root.style.setProperty('--sidebar-text-muted', '#636366');
      root.style.setProperty('--sidebar-line', 'rgba(84, 84, 88, 0.36)');
      root.style.setProperty('--sidebar-panel-text', '#ffffff');
      root.style.setProperty('--sidebar-panel-secondary', '#98989d');
      root.style.setProperty('--sidebar-panel-muted', '#636366');
      root.style.setProperty('--sidebar-panel-line', 'rgba(84, 84, 88, 0.36)');
    } else {
      root.style.setProperty('--color-text', '#1d1d1f');
      root.style.setProperty('--color-text-secondary', '#6e6e73');
      root.style.setProperty('--color-text-muted', '#8e8e93');
      root.style.setProperty('--border-color', 'rgba(60, 60, 67, 0.12)');
      root.style.setProperty('--border-color-strong', 'rgba(60, 60, 67, 0.18)');
      root.style.setProperty('--sidebar-text', '#1d1d1f');
      root.style.setProperty('--sidebar-text-secondary', '#6e6e73');
      root.style.setProperty('--sidebar-text-muted', '#8e8e93');
      root.style.setProperty('--sidebar-line', 'rgba(60, 60, 67, 0.12)');
      root.style.setProperty('--sidebar-panel-text', '#1d1d1f');
      root.style.setProperty('--sidebar-panel-secondary', '#6e6e73');
      root.style.setProperty('--sidebar-panel-muted', '#8e8e93');
      root.style.setProperty('--sidebar-panel-line', 'rgba(60, 60, 67, 0.12)');
    }
  }

  let backgroundColorPersistTimer: ReturnType<typeof setTimeout> | undefined;

  function setBackgroundColor(color: string | undefined): void {
    // Persist empty string (not undefined) so IPC/JSON reliably clears the override.
    const normalized = normalizeBackgroundColor(color);
    const persisted = normalized ?? '';
    settings.value = { ...settings.value, backgroundColor: persisted };
    applyBackgroundColor(persisted);
    // Debounce disk/IPC writes while dragging the color picker.
    if (backgroundColorPersistTimer) clearTimeout(backgroundColorPersistTimer);
    backgroundColorPersistTimer = setTimeout(() => {
      void update({ backgroundColor: settings.value.backgroundColor ?? '' });
    }, 180);
  }

  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  systemTheme.addEventListener('change', () => {
    if (settings.value.theme === 'system') {
      void syncNativeTheme('system').then((resolved) => applyTheme('system', resolved));
    }
  });

  return {
    settings,
    isLoaded,
    resolvedTheme,
    load,
    update,
    applyTheme,
    setTheme,
    applyAppearance,
    setAppearance,
    applyFontSize,
    setFontSize,
    applyBackgroundColor,
    setBackgroundColor,
  };
});
