import type { UpdateStatus } from '@shared/types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { bridge } from '../api/bridge';

export const useUpdateStore = defineStore('update', () => {
  const status = ref<UpdateStatus>({ state: 'idle' });

  let unlisten: (() => void) | null = null;

  async function init(): Promise<void> {
    try {
      status.value = await bridge.getUpdateStatus();
    } catch {
      // preload might not be ready or running in a non-Electron context
    }

    unlisten = bridge.onUpdateStatus((newStatus) => {
      status.value = newStatus;
      // Auto-install when download completes
      if (newStatus.state === 'downloaded') {
        bridge.installUpdate();
      }
    });
  }

  function cleanup(): void {
    unlisten?.();
    unlisten = null;
  }

  /** Start the full update flow: download then auto-install */
  function startUpdate(): void {
    bridge.downloadUpdate();
  }

  /** Manual check (via settings panel) */
  function checkForUpdates(): void {
    bridge.checkForUpdates();
  }

  function installUpdate(): void {
    bridge.installUpdate();
  }

  function dismiss(): void {
    if (status.value.version) {
      bridge.skipVersion(status.value.version);
    }
    status.value = { state: 'idle' };
  }

  return {
    status,
    init,
    cleanup,
    startUpdate,
    checkForUpdates,
    installUpdate,
    dismiss,
  };
});
