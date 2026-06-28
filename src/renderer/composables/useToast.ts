import { ref } from 'vue';

export interface Toast {
  id: number;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

const toasts = ref<Toast[]>([]);
let nextId = 0;

const DEFAULT_DURATION = 3000;

/** Show a toast notification. Returns its id for manual dismiss. */
function showToast(message: string, type: Toast['type'] = 'info', duration = DEFAULT_DURATION): number {
  const id = nextId++;
  const toast: Toast = { id, message, type };
  toasts.value.push(toast);

  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration);
  }

  return id;
}

/** Dismiss a toast by id */
function dismissToast(id: number): void {
  const index = toasts.value.findIndex((t) => t.id === id);
  if (index >= 0) toasts.value.splice(index, 1);
}

export function useToast() {
  return { toasts, showToast, dismissToast };
}
