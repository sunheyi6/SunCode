<script setup lang="ts">
import { onMounted } from 'vue';
import { useFilesStore } from '../../stores/files';

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
        ⟳
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
import { defineComponent, type PropType } from 'vue';
import type { FileNode } from '@shared/types';

const FileTreeNode = defineComponent({
  name: 'FileTreeNode',
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
    };
  },
  template: `
    <div class="tree-node" :style="{ paddingLeft: (depth * 16 + 8) + 'px' }">
      <div class="tree-row" @click="handleClick">
        <span class="tree-icon">
          {{ node.type === 'directory' ? (isExpanded() ? '▾' : '▸') : '📄' }}
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
          @toggle="(path: string) => emit('toggle', path)"
          @select="(path: string) => emit('select', path)"
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
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.header-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-secondary);
}

.refresh-btn {
  padding: 2px 6px;
  font-size: 14px;
  background: none;
  border: none;
  color: var(--color-text-secondary);
}

.refresh-btn:hover {
  color: var(--color-text);
  background: var(--color-surface-hover);
}

.file-tree-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.empty-state {
  padding: 20px 12px;
  color: var(--color-text-muted);
  font-size: 13px;
  text-align: center;
}

.tree-node {
  cursor: default;
}

.tree-row {
  display: flex;
  align-items: center;
  padding: 3px 0;
  font-size: 13px;
  cursor: pointer;
  border-radius: 3px;
  margin: 0 4px;
  padding: 3px 4px;
}

.tree-row:hover {
  background: var(--color-surface-hover);
}

.tree-row.selected {
  background: var(--color-accent);
  color: var(--color-bg);
}

.tree-icon {
  width: 16px;
  text-align: center;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-text-muted);
  margin-right: 4px;
}

.tree-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
