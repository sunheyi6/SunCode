import { ref } from 'vue';
import type { BackgroundProcess } from '@shared/types';
import { bridge } from '../api/bridge';
import { completeProcess, upsertStartedProcess } from './background-process-state';

const processes = ref<BackgroundProcess[]>([]);
let listening = false;

function ensureListening(): void {
  if (listening) return;
  listening = true;

  bridge.onBgProcessStarted((data) => {
    upsertStartedProcess(processes.value, data.process);
  });
  bridge.onBgProcessCompleted((data) => {
    completeProcess(processes.value, data.pid, data.exitCode);
  });
}

export function useBackgroundProcesses() {
  ensureListening();
  // Note: not wrapped with readonly() because GitPanel's stopProcess() and
  // the internal callbacks need to mutate array elements in place (status/exitCode).
  return { processes };
}
