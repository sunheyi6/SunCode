import type { AgentStatus, ToolResult } from '@shared/types';
import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface ToolExecution {
  id: string;
  toolName: string;
  status: 'running' | 'done' | 'error';
  result?: ToolResult;
  startTime: number;
}

export interface PendingPrompt {
  id: string;
  text: string;
  createdAt: number;
}

export const useAgentStore = defineStore('agent', () => {
  const status = ref<AgentStatus>({
    state: 'idle',
    turnCount: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
    modelName: '',
  });

  /** Per-session agent status (for concurrent agent runs). */
  const sessionStatus = new Map<string, AgentStatus>();

  const toolExecutions = ref<ToolExecution[]>([]);
  const error = ref<string | null>(null);
  const pendingPrompts = ref<PendingPrompt[]>([]);
  const goalActive = ref(false);

  function setStatus(newStatus: AgentStatus, sid?: string): void {
    status.value = newStatus;
    if (sid) sessionStatus.set(sid, newStatus);
  }

  function getSessionStatus(sid: string): AgentStatus {
    return sessionStatus.get(sid) ?? {
      state: 'idle',
      turnCount: 0,
      tokenUsage: { input: 0, output: 0, total: 0 },
      modelName: '',
    };
  }

  function setGoalActive(active: boolean): void {
    goalActive.value = active;
  }

  function startToolExecution(toolCallId: string, toolName: string): void {
    toolExecutions.value.push({
      id: toolCallId,
      toolName,
      status: 'running',
      startTime: Date.now(),
    });
  }

  function endToolExecution(result: ToolResult): void {
    const execution = toolExecutions.value.find((e) => e.id === result.toolCallId);
    if (execution) {
      execution.status = result.success ? 'done' : 'error';
      execution.result = result;
    }
  }

  function setError(message: string): void {
    error.value = message;
  }

  function clearError(): void {
    error.value = null;
  }

  function enqueuePrompt(text: string): void {
    pendingPrompts.value.push({
      id: `pending_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      text,
      createdAt: Date.now(),
    });
  }

  function takePrompt(id: string): PendingPrompt | null {
    const index = pendingPrompts.value.findIndex((prompt) => prompt.id === id);
    if (index < 0) return null;
    return pendingPrompts.value.splice(index, 1)[0] || null;
  }

  function takeLatestPrompt(): PendingPrompt | null {
    return pendingPrompts.value.pop() || null;
  }

  function reset(): void {
    status.value = {
      state: 'idle',
      turnCount: 0,
      tokenUsage: { input: 0, output: 0, total: 0 },
      modelName: status.value.modelName,
    };
    toolExecutions.value = [];
    error.value = null;
    pendingPrompts.value = [];
    goalActive.value = false;
  }

  return {
    status,
    toolExecutions,
    error,
    pendingPrompts,
    goalActive,
    setStatus,
    getSessionStatus,
    setGoalActive,
    startToolExecution,
    endToolExecution,
    setError,
    clearError,
    enqueuePrompt,
    takePrompt,
    takeLatestPrompt,
    reset,
  };
});
