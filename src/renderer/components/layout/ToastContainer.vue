<script setup lang="ts">
import { useToast } from '../../composables/useToast';

const { toasts, dismissToast } = useToast();

function iconFor(type: 'info' | 'success' | 'warning' | 'error'): string {
  switch (type) {
    case 'success': return '✓';
    case 'warning': return '⚠';
    case 'error': return '✕';
    default: return 'ℹ';
  }
}
</script>

<template>
  <Teleport to="body">
    <TransitionGroup name="toast" tag="div" class="toast-container">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="toast-item"
        :class="`toast-${toast.type}`"
      >
        <span class="toast-icon">{{ iconFor(toast.type) }}</span>
        <span class="toast-message">{{ toast.message }}</span>
        <button
          class="toast-dismiss"
          @click="dismissToast(toast.id)"
          aria-label="关闭提示"
        >✕</button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<style scoped>
.toast-container {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 200;
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  max-width: 380px;
  pointer-events: none;
}

.toast-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.4;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  backdrop-filter: blur(12px);
  pointer-events: auto;
  border: 1px solid transparent;
}

.toast-info {
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-bg-secondary));
  border-color: color-mix(in srgb, var(--color-accent) 20%, var(--border-color-strong));
  color: var(--color-text);
}
.toast-success {
  background: color-mix(in srgb, var(--color-green) 12%, var(--color-bg-secondary));
  border-color: color-mix(in srgb, var(--color-green) 25%, var(--border-color-strong));
  color: var(--color-text);
}
.toast-warning {
  background: color-mix(in srgb, var(--color-yellow) 14%, var(--color-bg-secondary));
  border-color: color-mix(in srgb, var(--color-yellow) 30%, var(--border-color-strong));
  color: var(--color-text);
}
.toast-error {
  background: color-mix(in srgb, var(--color-red) 12%, var(--color-bg-secondary));
  border-color: color-mix(in srgb, var(--color-red) 25%, var(--border-color-strong));
  color: var(--color-text);
}

.toast-icon {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
}

.toast-info .toast-icon {
  background: color-mix(in srgb, var(--color-accent) 20%, transparent);
  color: var(--color-accent);
}
.toast-success .toast-icon {
  background: color-mix(in srgb, var(--color-green) 25%, transparent);
  color: var(--color-green);
}
.toast-warning .toast-icon {
  background: color-mix(in srgb, var(--color-yellow) 30%, transparent);
  color: var(--color-yellow);
}
.toast-error .toast-icon {
  background: color-mix(in srgb, var(--color-red) 25%, transparent);
  color: var(--color-red);
}

.toast-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toast-dismiss {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s;
}
.toast-dismiss:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

/* Transition */
.toast-enter-active {
  transition: all 0.25s ease-out;
}
.toast-leave-active {
  transition: all 0.2s ease-in;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(40px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(40px);
}
</style>
