<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import 'vanilla-colorful/hex-color-picker.js';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** Fallback when modelValue is empty (theme default). */
    fallback?: string;
  }>(),
  {
    fallback: '#000000',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const pickerRef = ref<(HTMLElement & { color: string }) | null>(null);

const displayColor = computed(() => {
  const value = props.modelValue.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(value)) return value.toUpperCase();
  return props.fallback;
});

function onColorChanged(event: Event): void {
  const detail = (event as CustomEvent<{ value: string }>).detail;
  const next = detail?.value?.toUpperCase();
  if (next) emit('update:modelValue', next);
}

function toggle(): void {
  open.value = !open.value;
}

function close(): void {
  open.value = false;
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node | null;
  if (!rootRef.value || !target) return;
  if (!rootRef.value.contains(target)) close();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close();
}

watch(
  () => displayColor.value,
  (color) => {
    if (pickerRef.value && pickerRef.value.color !== color) {
      pickerRef.value.color = color;
    }
  },
);

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onKeydown);
  if (pickerRef.value) {
    pickerRef.value.color = displayColor.value;
  }
});

onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div ref="rootRef" class="bg-picker">
    <button
      class="bg-picker-trigger"
      type="button"
      title="打开调色盘"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="toggle"
    >
      <span class="bg-picker-swatch" :style="{ background: displayColor }" />
      <span class="bg-picker-label">调色盘</span>
    </button>

    <div v-show="open" class="bg-picker-popover" role="dialog" aria-label="选择背景色">
      <!-- vanilla-colorful: react-colorful style SV square + hue bar -->
      <hex-color-picker
        ref="pickerRef"
        class="bg-picker-board"
        :color="displayColor"
        @color-changed="onColorChanged"
      />
      <div class="bg-picker-footer">
        <span class="bg-picker-hex">{{ displayColor }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bg-picker {
  position: relative;
  display: inline-flex;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.bg-picker-popover,
.bg-picker-board,
.bg-picker-trigger {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.bg-picker-trigger {
  display: inline-flex;
  height: 34px;
  align-items: center;
  gap: 8px;
  padding: 0 12px 0 8px;
  border: 1px solid var(--border-color-strong);
  border-radius: var(--border-radius-pill);
  background: var(--color-bg);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.bg-picker-trigger:hover {
  background: var(--color-surface-hover);
}

.bg-picker-swatch {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  border: 1px solid var(--border-color-strong);
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
}

.bg-picker-label {
  line-height: 1;
}

.bg-picker-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 1200;
  width: 220px;
  padding: 12px;
  border: 1px solid var(--border-color-strong);
  border-radius: 16px;
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
}

.bg-picker-board {
  display: block;
  width: 100%;
  height: 180px;
}

.bg-picker-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
}

.bg-picker-hex {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.02em;
}

/* vanilla-colorful CSS parts — match the classic rounded thumbs look */
.bg-picker-board {
  --vc-saturation-width: 100%;
  --vc-saturation-height: 150px;
  --vc-hue-height: 12px;
  --vc-pointer-size: 18px;
}
</style>
