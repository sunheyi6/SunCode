import { ref } from 'vue';
import { useSettingsStore } from '../stores/settings';

/**
 * Composable for theme management.
 */
export function useTheme() {
  const settingsStore = useSettingsStore();
  const theme = ref<'system' | 'light' | 'dark'>(settingsStore.settings.theme);

  function toggle(): void {
    const newTheme = theme.value === 'dark' ? 'light' : 'dark';
    theme.value = newTheme;
    document.documentElement.setAttribute('data-theme', newTheme);
    settingsStore.setTheme(newTheme);
  }

  function setTheme(newTheme: 'system' | 'light' | 'dark'): void {
    theme.value = newTheme;
    document.documentElement.setAttribute('data-theme', newTheme);
    settingsStore.setTheme(newTheme);
  }

  return {
    theme,
    toggle,
    setTheme,
    isDark: () => theme.value === 'dark',
  };
}
