import { readonly, ref } from 'vue';
import type { BackgroundProcess } from '@shared/types';
import { bridge } from '../api/bridge';
import { completeProcess, upsertStartedProcess } from './background-process-state';

const processes = ref<BackgroundProcess[]>([]);
let listening = false;

function ensureListening(): void {
  if (listening) return;
  listening = true;

  bridge.onBgProcessStarted((process) => {
    upsertStartedProcess(processes.value, process);
  });
  bridge.onBgProcessCompleted((pid, exitCode) => {
    completeProcess(processes.value, pid, exitCode);
  });
}

export function useBackgroundProcesses() {
  ensureListening();
  return { processes: readonly(processes) };
}
