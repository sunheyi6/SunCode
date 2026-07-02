<script setup lang="ts">
import { useAgentStore } from '../../stores/agent';

const emit = defineEmits<{
  sendNow: [id: string];
  remove: [id: string];
}>();

const agentStore = useAgentStore();
</script>

<template>
  <div v-if="agentStore.pendingPrompts.length" class="pending-queue">
    <div class="queue-header">
      <span>等待队列</span>
      <span class="queue-count">{{ agentStore.pendingPrompts.length }}</span>
      <span class="queue-hint">回答完成后按顺序自动发送</span>
    </div>

    <div class="queue-items">
      <div
        v-for="(prompt, index) in agentStore.pendingPrompts"
        :key="prompt.id"
        class="queue-item"
        :class="{ first: index === 0 }"
      >
        <span class="queue-order">{{ index + 1 }}</span>
        <span class="queue-text">{{ prompt.text }}</span>
        <span v-if="index === 0" class="first-badge">
          即将发送
        </span>
        <button
          class="guide-btn"
          title="中断当前回答并立即发送本条消息"
          @click="emit('sendNow', prompt.id)"
        >
          引导
        </button>
        <button
          class="remove-btn"
          title="从队列中移除"
          @click="emit('remove', prompt.id)"
        >
          ✕
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pending-queue {
  flex-shrink: 0;
  padding: 8px var(--spacing-xl) 0;
  background: var(--color-bg-secondary);
}

.queue-header {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 650;
}

.queue-count {
  min-width: 18px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--color-accent);
  color: var(--color-bg);
  text-align: center;
  font-size: 10px;
}

.queue-hint {
  margin-left: auto;
  color: var(--color-text-muted);
  font-weight: 400;
}

.queue-items {
  display: flex;
  max-height: 128px;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}

.queue-item {
  display: flex;
  min-height: 36px;
  align-items: center;
  gap: 8px;
  padding: 5px 7px;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: var(--color-surface);
}

.queue-item.first {
  border-color: color-mix(in srgb, var(--color-accent) 45%, var(--border-color));
}

.queue-order {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  text-align: center;
  font-size: 10px;
  line-height: 18px;
}

.queue-text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--color-text);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.first-badge {
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  color: var(--color-accent);
  font-size: 10px;
}

.guide-btn {
  flex-shrink: 0;
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--color-accent) 35%, var(--border-color));
  border-radius: var(--border-radius-sm);
  background: transparent;
  color: var(--color-accent);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.12s ease;
}

.guide-btn:hover {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
}

.remove-btn {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--border-radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.12s ease;
}

.remove-btn:hover {
  border-color: var(--border-color);
  background: var(--color-surface-hover);
  color: var(--color-red);
}
</style>
