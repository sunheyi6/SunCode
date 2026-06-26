<script setup lang="ts">
import { computed } from 'vue';
import { useAgentStore } from '../../stores/agent';
import { useModelsStore } from '../../stores/models';

const agentStore = useAgentStore();
const modelsStore = useModelsStore();

const statusColor = computed(() => {
  switch (agentStore.status.state) {
    case 'thinking':
      return 'var(--color-yellow)';
    case 'executing':
      return 'var(--color-teal)';
    case 'done':
      return 'var(--color-green)';
    case 'error':
      return 'var(--color-red)';
    default:
      return 'var(--color-text-muted)';
  }
});

const statusText = computed(() => {
  switch (agentStore.status.state) {
    case 'idle':
      return '就绪';
    case 'thinking':
      return '思考中...';
    case 'executing':
      return '执行工具...';
    case 'done':
      return '完成';
    case 'error':
      return '错误';
    default:
      return '';
  }
});

const tokenInfo = computed(() => {
  const t = agentStore.status.tokenUsage;
  if (t.total === 0) return '';
  return `${t.total} tokens`;
});
</script>

<template>
  <div class="status-bar">
    <div class="status-left">
      <span class="status-dot" :style="{ background: statusColor }" />
      <span class="status-text">{{ statusText }}</span>
      <template v-if="agentStore.goalActive">
        <span class="goal-badge">🎯 Goal</span>
      </template>
      <span class="status-separator">|</span>
      <span class="status-model">{{ modelsStore.getCurrentLabel() }}</span>
    </div>
    <div class="status-right">
      <span class="status-tokens">{{ tokenInfo }}</span>
      <span class="status-separator">|</span>
      <span class="status-turns">第 {{ agentStore.status.turnCount }} 轮</span>
    </div>
  </div>
</template>

<style scoped>
.status-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  background: var(--color-bg-tertiary);
  border-top: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.status-left, .status-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.status-separator {
  color: var(--color-text-muted);
  opacity: 0.5;
}

.status-model {
  color: var(--color-text);
  font-weight: 500;
}

.goal-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: 10px;
  background: color-mix(in srgb, #f59e0b 15%, transparent);
  color: #d97706;
  font-weight: 700;
  font-size: 11px;
}
</style>
