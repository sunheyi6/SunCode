<script setup lang="ts">
import { onMounted } from 'vue';
import { useFilesStore } from '../../stores/files';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';

const filesStore = useFilesStore();

onMounted(() => {
  filesStore.loadFileTree();
});
</script>

<template>
  <div class="file-tree">
    <div class="file-tree-header">
      <span class="header-title">文件</span>
      <button class="refresh-btn" title="刷新" @click="filesStore.loadFileTree()">
        <AppIcon name="refresh" :size="14" />
      </button>
    </div>

    <div class="file-tree-list">
      <template v-if="filesStore.fileTree.length > 0">
        <div
          v-for="node in filesStore.fileTree"
          :key="node.path"
        >
          <FileTreeNode
            :node="node"
            :depth="0"
            :expanded="filesStore.expanded"
            @toggle="filesStore.toggleExpand"
            @select="filesStore.selectFile"
          />
        </div>
      </template>
      <div v-else class="empty-state">
        暂无文件，点击刷新按钮加载。
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import type { FileNode } from '@shared/types';
import { defineComponent, type PropType } from 'vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';

const FileTreeNode = defineComponent({
  name: 'FileTreeNode',
  components: { AppIcon },
  props: {
    node: { type: Object as PropType<FileNode>, required: true },
    depth: { type: Number, default: 0 },
    expanded: { type: Object as PropType<Set<string>>, required: true },
  },
  emits: ['toggle', 'select'],
  setup(props, { emit }) {
    return {
      isExpanded: () => props.expanded.has(props.node.path),
      handleClick() {
        if (props.node.type === 'directory') {
          emit('toggle', props.node.path);
        } else {
          emit('select', props.node.path);
        }
      },
      treeIconName(): string {
        if (props.node.type !== 'directory') return 'file';
        return props.expanded.has(props.node.path) ? 'folder-open' : 'folder';
      },
    };
  },
  template: `
    <div class="tree-node" :style="{ paddingLeft: (depth * 16 + 8) + 'px' }">
      <div class="tree-row" @click="handleClick">
        <span class="tree-icon">
          <AppIcon :name="treeIconName()" :size="14" />
        </span>
        <span class="tree-name" :class="{ selected: false }">{{ node.name }}</span>
      </div>
      <template v-if="node.type === 'directory' && isExpanded() && node.children">
        <FileTreeNode
          v-for="child in node.children"
          :key="child.path"
          :node="child"
          :depth="depth + 1"
          :expanded="expanded"
          @toggle="(path) => emit('toggle', path)"
          @select="(path) => emit('select', path)"
        />
      </template>
    </div>
  `,
});
</script>

<style scoped>
.file-tree {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.file-tree-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
}

.header-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--border-radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}

.refresh-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.file-tree-list {
  flex: 1;
  overflow: auto;
  padding: 4px 0;
}

.empty-state {
  padding: 16px 12px;
  color: var(--color-text-muted);
  font-size: 13px;
}

:deep(.tree-row) {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding-right: 8px;
  cursor: pointer;
  color: var(--color-text-secondary);
}

:deep(.tree-row:hover) {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

:deep(.tree-icon) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

:deep(.tree-name) {
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
