<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useAgentStore } from '../../stores/agent';
import { useModelsStore } from '../../stores/models';

const agentStore = useAgentStore();
const modelsStore = useModelsStore();

const statusColor = computed(() => {
  switch (agentStore.status.state) {
    case 'thinking':  return 'var(--color-yellow)';
    case 'executing': return 'var(--color-teal)';
    case 'done':      return 'var(--color-green)';
    case 'error':     return 'var(--color-red)';
    default:          return 'var(--color-text-muted)';
  }
});

const statusText = computed(() => {
  switch (agentStore.status.state) {
    case 'idle':      return '就绪';
    case 'thinking':  return '思考中...';
    case 'executing': return '执行工具...';
    case 'done':      return '完成';
    case 'error':     return '错误';
    default:          return '';
  }
});

const tokenInfo = computed(() => {
  const t = agentStore.status.tokenUsage;
  if (t.total === 0) return '';
  return `${t.total} tokens`;
});

// -- elapsed time since run started --
const elapsedSeconds = ref(0);
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

watch(
  () => agentStore.status.state,
  (state) => {
    if (state === 'thinking' || state === 'executing') {
      if (!elapsedTimer) {
        elapsedSeconds.value = 0;
        elapsedTimer = setInterval(() => { elapsedSeconds.value++; }, 1000);
      }
    } else {
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    }
  },
);

onBeforeUnmount(() => { if (elapsedTimer) clearInterval(elapsedTimer); });

const elapsedLabel = computed(() => {
  if (elapsedSeconds.value === 0) return '';
  const s = elapsedSeconds.value;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remain = s % 60;
  return remain > 0 ? `${m}m${remain}s` : `${m}m`;
});
</script>

<template>
  <div class="status-bar">
    <div class="status-left">
      <span class="status-dot" :style="{ background: statusColor }" />
      <span class="status-text">{{ statusText }}</span>
      <template v-if="agentStore.goalActive">
        <span class="goal-badge">Goal</span>
      </template>
      <span class="status-separator">|</span>
      <span class="status-model">{{ modelsStore.getCurrentLabel() }}</span>
    </div>
    <div class="status-right">
      <span v-if="elapsedLabel" class="status-elapsed">{{ elapsedLabel }}</span>
      <span v-if="elapsedLabel" class="status-separator">|</span>
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

.status-elapsed {
  font-family: var(--font-mono);
  color: var(--color-text-muted);
}

.goal-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: var(--border-radius-sm);
  background: color-mix(in srgb, var(--color-orange) 12%, transparent);
  color: var(--color-orange);
  font-weight: 600;
  font-size: 11px;
}
</style>
