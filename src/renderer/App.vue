<script setup lang="ts">
import { onMounted } from 'vue';
import { useModelsStore } from './stores/models';
import { useSettingsStore } from './stores/settings';
import { useUpdateStore } from './stores/update';
import './styles/code-theme.css';
import AppLayout from './components/layout/AppLayout.vue';

const modelsStore = useModelsStore();
const settingsStore = useSettingsStore();
const updateStore = useUpdateStore();

onMounted(async () => {
  const settings = await settingsStore.load();
  await Promise.all([modelsStore.initAll(settings), updateStore.init()]);
});
</script>

<template>
  <AppLayout />
</template>

<style>
/* App-level styles */
#app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
</style>
