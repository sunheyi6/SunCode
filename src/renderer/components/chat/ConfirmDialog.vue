<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  /** 工具名称 */
  toolName: string;
  /** 人性化的操作描述 */
  description: string;
  /** 是否显示 */
  visible: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  deny: [];
}>();

const toolLabel = computed(() => {
  const labels: Record<string, string> = {
    bash: '终端命令',
    write: '写入文件',
    edit: '编辑文件',
    subagent: '子代理',
  };
  return labels[props.toolName] || props.toolName;
});

const toolIcon = computed(() => {
  const icons: Record<string, string> = {
    bash: '💻',
    write: '📝',
    edit: '✏️',
    subagent: '🤖',
  };
  return icons[props.toolName] || '🔧';
});
</script>

<template>
  <Teleport to="body">
    <Transition name="confirm">
      <div v-if="visible" class="confirm-backdrop" @click.self="emit('deny')">
        <div class="confirm-dialog">
          <div class="confirm-header">
            <span class="confirm-icon">{{ toolIcon }}</span>
            <span class="confirm-title">确认执行 {{ toolLabel }}</span>
          </div>
          <div class="confirm-body">
            <p class="confirm-desc">
              Agent 想要执行 <strong>{{ toolLabel }}</strong> 操作
            </p>
            <pre v-if="description" class="confirm-detail">{{ description }}</pre>
            <p v-else class="confirm-no-detail">（无额外信息）</p>
          </div>
          <div class="confirm-actions">
            <button class="confirm-btn deny" @click="emit('deny')">
              ✕ 取消
            </button>
            <button class="confirm-btn allow" @click="emit('confirm')">
              ✓ 允许执行
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.confirm-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.confirm-dialog {
  width: 460px;
  max-width: 90vw;
  background: var(--color-bg);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

.confirm-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  background: var(--color-bg-secondary);
}

.confirm-icon {
  font-size: 20px;
}

.confirm-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}

.confirm-body {
  padding: 16px 20px;
}

.confirm-desc {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.confirm-detail {
  margin: 0;
  padding: 10px 12px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

.confirm-no-detail {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-muted);
  font-style: italic;
}

.confirm-actions {
  display: flex;
  gap: 10px;
  padding: 12px 20px 16px;
  justify-content: flex-end;
  border-top: 1px solid var(--border-color);
}

.confirm-btn {
  padding: 8px 20px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.confirm-btn.deny {
  background: var(--color-surface);
  color: var(--color-text-secondary);
}

.confirm-btn.deny:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.confirm-btn.allow {
  background: var(--color-accent);
  color: var(--color-bg);
  border-color: var(--color-accent);
}

.confirm-btn.allow:hover {
  background: var(--color-accent-hover);
}

/* Transition */
.confirm-enter-active {
  transition: opacity 0.15s ease;
}
.confirm-leave-active {
  transition: opacity 0.1s ease;
}
.confirm-enter-active .confirm-dialog {
  transition: transform 0.15s ease, opacity 0.15s ease;
}
.confirm-leave-active .confirm-dialog {
  transition: transform 0.1s ease, opacity 0.1s ease;
}
.confirm-enter-from {
  opacity: 0;
}
.confirm-enter-from .confirm-dialog {
  transform: scale(0.95);
  opacity: 0;
}
.confirm-leave-to {
  opacity: 0;
}
.confirm-leave-to .confirm-dialog {
  transform: scale(0.95);
  opacity: 0;
}
</style>
