import type { UpdateStatus } from '@shared/types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { bridge } from '../api/bridge';

export const useUpdateStore = defineStore('update', () => {
  const status = ref<UpdateStatus>({ state: 'idle' });
  /** Track the latest version across state changes so dismiss() can always
   *  tell the main process to skip it, even during downloading/error states
   *  where the UpdateStatus does not carry the version field. */
  let lastVersion: string | undefined;

  let unlisten: (() => void) | null = null;

  async function init(): Promise<void> {
    try {
      const s = await bridge.getUpdateStatus();
      status.value = s;
      if (s.version) lastVersion = s.version;
    } catch {
      // preload might not be ready or running in a non-Electron context
    }

    unlisten = bridge.onUpdateStatus((newStatus) => {
      status.value = newStatus;
      if (newStatus.version) lastVersion = newStatus.version;
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
    // Always use the last known version, not just status.value.version,
    // because during downloading/error states the version field is absent.
    if (lastVersion) {
      bridge.skipVersion(lastVersion);
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
