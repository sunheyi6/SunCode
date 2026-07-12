import type { AppearanceStyle } from '@shared/types';
import { computed } from 'vue';
import { useSettingsStore } from '../stores/settings';

/**
 * Composable for theme management.
 */
export function useTheme() {
  const settingsStore = useSettingsStore();
  const theme = computed(() => settingsStore.settings.theme);
  const appearance = computed(() => settingsStore.settings.appearance ?? 'apple');

  function toggle(): void {
    const newTheme = settingsStore.resolvedTheme === 'dark' ? 'light' : 'dark';
    settingsStore.setTheme(newTheme);
  }

  function setTheme(newTheme: 'system' | 'light' | 'dark'): void {
    settingsStore.setTheme(newTheme);
  }

  function setAppearance(newStyle: AppearanceStyle): void {
    settingsStore.setAppearance(newStyle);
  }

  return {
    theme,
    appearance,
    toggle,
    setTheme,
    setAppearance,
    isDark: () => settingsStore.resolvedTheme === 'dark',
  };
}
