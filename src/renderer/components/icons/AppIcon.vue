<script setup lang="ts">
import { computed } from 'vue';
import { type IconName, resolveIcon } from './icons';

const props = withDefaults(
  defineProps<{
    name: IconName | string;
    size?: number;
    strokeWidth?: number;
  }>(),
  {
    size: 16,
    strokeWidth: 1.75,
  },
);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const icon = computed(() => resolveIcon(props.name));
</script>

<template>
  <component
    :is="icon"
    v-if="icon"
    class="app-icon"
    :class="{ spin: name === 'loader' }"
    :size="size"
    :stroke-width="strokeWidth"
    aria-hidden="true"
  />
</template>

<style scoped>
.app-icon {
  display: block;
  flex-shrink: 0;
}

.app-icon.spin {
  animation: app-icon-spin 0.8s linear infinite;
}

@keyframes app-icon-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
