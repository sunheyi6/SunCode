import { onUnmounted, reactive } from 'vue';

/** Reactive state shared by ConfirmDialog component and IPC listener. */
export const confirmState = reactive({
  visible: false,
  toolCallId: '',
  toolName: '',
  description: '',
});

let resolveCurrent: ((confirmed: boolean) => void) | null = null;
let cleanup: (() => void) | null = null;

/**
 * Parse human-readable description from tool call arguments.
 */
function parseDescription(toolName: string, rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    switch (toolName) {
      case 'bash':
        return (parsed.command as string) || '';
      case 'write': {
        const fp = (parsed.file_path as string) || '';
        const preview = (parsed.content as string)?.slice(0, 120) || '';
        return fp ? `${fp}\n${preview}` : preview;
      }
      case 'edit': {
        const fp = (parsed.file_path as string) || '';
        const old = (parsed.old_string as string)?.slice(0, 120) || '';
        return fp ? `${fp}\n${old}` : old;
      }
      case 'subagent': {
        const agent = (parsed.agent as string) || '';
        const calls = parsed.calls as Array<Record<string, unknown>> | undefined;
        if (calls?.length) {
          return calls.map((c) => c.agent || '?').join(', ');
        }
        return agent || '';
      }
      default:
        return rawArgs.slice(0, 200);
    }
  } catch {
    return rawArgs.slice(0, 200);
  }
}

/**
 * Listen for confirm requests from the main process and show the dialog.
 * Must be called once (e.g., in AppLayout setup).
 */
export function useConfirmDialog() {
  if (cleanup) return { confirmState, handleConfirm, handleDeny };

  cleanup = window.suncode.onConfirmRequest((request) => {
    confirmState.toolCallId = request.toolCallId;
    confirmState.toolName = request.toolName;
    confirmState.description = parseDescription(request.toolName, request.description);
    confirmState.visible = true;

    resolveCurrent = (confirmed: boolean) => {
      window.suncode.respondConfirm(request.toolCallId, confirmed);
      resolveCurrent = null;
    };
  });

  onUnmounted(() => {
    cleanup?.();
    cleanup = null;
  });

  return { confirmState, handleConfirm, handleDeny };
}

function handleConfirm() {
  confirmState.visible = false;
  resolveCurrent?.(true);
}

function handleDeny() {
  confirmState.visible = false;
  resolveCurrent?.(false);
}
