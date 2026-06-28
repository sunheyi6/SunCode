import { ref } from 'vue';
import type { BackgroundProcess } from '@shared/types';
import { bridge } from '../api/bridge';
import {
  completeProcess,
  markProcessKilled,
  removeProcess,
  updateProcessPorts,
  upsertStartedProcess,
} from './background-process-state';

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
    // When the OS confirms a kill, remove the process from the list
    if (data.exitCode === -1) {
      removeProcess(processes.value, data.pid);
    }
  });
  bridge.onBgProcessPortsVerified((data) => {
    updateProcessPorts(processes.value, data.pid, data.ports);
  });
}

/** Kill all running background processes, returning count of killed */
function killAll(): number {
  const running = processes.value.filter((p) => p.status === 'running' && !p.killed);
  for (const proc of running) {
    markProcessKilled(processes.value, proc.pid);
    bridge.killBgProcess(proc.pid);
  }
  return running.length;
}

export function useBackgroundProcesses() {
  ensureListening();
  return { processes, killAll };
}
