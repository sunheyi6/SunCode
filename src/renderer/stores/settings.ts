import type { AppSettings } from '@shared/types';
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
    theme: 'system',
    permissionMode: 'full_access',
    windowsShell: 'auto',
    fontSize: 14,
    mcpServers: [],
    skills: [],
    envApiKeys: {},
    customEndpoints: [],
    maxLessons: 200,
    taskCompleteNotification: 'never',
    createGitWorktree: false,
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
      applyFontSize(settings.value.fontSize);
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
  }

  function setTheme(theme: AppSettings['theme']): void {
    settings.value = { ...settings.value, theme };
    if (theme !== 'system') applyTheme(theme);
    void update({ theme });
    void syncNativeTheme(theme).then((resolved) => applyTheme(theme, resolved));
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
    applyFontSize,
    setFontSize,
  };
});
