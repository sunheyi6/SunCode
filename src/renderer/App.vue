<script setup lang="ts">
import { onMounted } from 'vue';
import { useModelsStore } from './stores/models';
import { useSettingsStore } from './stores/settings';
import AppLayout from './components/layout/AppLayout.vue';
import './styles/code-theme.css';

const modelsStore = useModelsStore();
const settingsStore = useSettingsStore();

onMounted(async () => {
  await settingsStore.load();
  await modelsStore.initAll();
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
