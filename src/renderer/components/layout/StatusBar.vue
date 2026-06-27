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
  padding: 4px 16px;
  font-size: 12px;
  background: var(--color-bg-secondary);
  border-top: 1px solid var(--color-overlay);
  color: var(--color-text-muted);
  user-select: none;
  min-height: 28px;
}
.status-left, .status-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-text {
  font-weight: 500;
}
.status-model {
  color: var(--color-text-muted);
}
.status-tokens,
.status-turns,
.status-elapsed {
  font-family: var(--font-mono);
}
.goal-badge {
  background: var(--color-accent);
  color: white;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  line-height: 16px;
}
.status-separator {
  opacity: 0.3;
}
</style>
