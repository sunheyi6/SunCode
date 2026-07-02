import type { AppSettings } from '@shared/types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { bridge } from '../api/bridge';

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({
    activeModel: 'claude-sonnet-4-5',
    activeProvider: 'anthropic',
    thinkingLevel: 'low',
    maxTurns: 50,
    autoCompact: true,
    compactThreshold: 0.7,
    theme: 'system',
    permissionMode: 'full_access',
    windowsShell: 'auto',
    fontSize: 14,
    mcpServers: [],
    skills: [],
    envApiKeys: {},
    maxLessons: 200,
  });

  const isLoaded = ref(false);

  async function load(): Promise<AppSettings> {
    try {
      const s = await bridge.getSettings();
      settings.value = { ...settings.value, ...s };
      applyTheme(settings.value.theme);
      applyFontSize(settings.value.fontSize);
      isLoaded.value = true;
      bridge.setTheme(resolveTheme(settings.value.theme));
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

  function applyTheme(theme: AppSettings['theme']): void {
    document.documentElement.setAttribute('data-theme', resolveTheme(theme));
  }

  function setTheme(theme: AppSettings['theme']): void {
    applyTheme(theme);
    update({ theme });
    bridge.setTheme(resolveTheme(theme));
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
    if (settings.value.theme === 'system') applyTheme('system');
  });

  return {
    settings,
    isLoaded,
    load,
    update,
    applyTheme,
    setTheme,
    applyFontSize,
    setFontSize,
  };
});
