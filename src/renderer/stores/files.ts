import type { FileNode } from '@shared/types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { bridge } from '../api/bridge';

export const useFilesStore = defineStore('files', () => {
  const fileTree = ref<FileNode[]>([]);
  const expanded = ref<Set<string>>(new Set());
  const selectedFile = ref<string | null>(null);
  const selectedFileContent = ref<string>('');

  async function loadFileTree(rootPath?: string): Promise<void> {
    try {
      fileTree.value = await bridge.getFileTree(rootPath);
    } catch (error) {
      console.error('Failed to load file tree:', error);
    }
  }

  function toggleExpand(path: string): void {
    if (expanded.value.has(path)) {
      expanded.value.delete(path);
    } else {
      expanded.value.add(path);
    }
  }

  async function selectFile(path: string): Promise<void> {
    selectedFile.value = path;
    try {
      selectedFileContent.value = await bridge.readFile(path);
    } catch (error) {
      console.error('Failed to read file:', error);
      selectedFileContent.value = `Error: ${(error as Error).message}`;
    }
  }

  function clearSelection(): void {
    selectedFile.value = null;
    selectedFileContent.value = '';
  }

  return {
    fileTree,
    expanded,
    selectedFile,
    selectedFileContent,
    loadFileTree,
    toggleExpand,
    selectFile,
    clearSelection,
  };
});
