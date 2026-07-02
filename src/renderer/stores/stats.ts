import type { TokenUsageSummary } from '@shared/types';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { bridge } from '../api/bridge';

export const useStatsStore = defineStore('stats', () => {
  const tokenUsage = ref<TokenUsageSummary | null>(null);
  const tokenUsageLoading = ref(false);
  const tokenUsageLoaded = ref(false);

  const hasTokenUsage = computed(() => tokenUsage.value !== null);

  async function loadTokenUsage(force = false): Promise<void> {
    if (tokenUsageLoading.value) return;
    if (tokenUsageLoaded.value && !force) return;

    tokenUsageLoading.value = true;
    try {
      tokenUsage.value = await bridge.getTokenUsage();
      tokenUsageLoaded.value = true;
    } catch (error) {
      console.error('Failed to load token usage:', error);
    } finally {
      tokenUsageLoading.value = false;
    }
  }

  function refreshTokenUsage(): Promise<void> {
    return loadTokenUsage(true);
  }

  return {
    tokenUsage,
    tokenUsageLoading,
    tokenUsageLoaded,
    hasTokenUsage,
    loadTokenUsage,
    refreshTokenUsage,
  };
});
