import { computed } from 'vue';
import { useSettingsStore } from '../stores/settings';

/**
 * Composable for theme management.
 */
export function useTheme() {
  const settingsStore = useSettingsStore();
  const theme = computed(() => settingsStore.settings.theme);

  function toggle(): void {
    const newTheme = settingsStore.resolvedTheme === 'dark' ? 'light' : 'dark';
    settingsStore.setTheme(newTheme);
  }

  function setTheme(newTheme: 'system' | 'light' | 'dark'): void {
    settingsStore.setTheme(newTheme);
  }

  return {
    theme,
    toggle,
    setTheme,
    isDark: () => settingsStore.resolvedTheme === 'dark',
  };
}
