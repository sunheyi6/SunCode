<script setup lang="ts">
import { computed } from 'vue';
import { bridge } from '../../api/bridge';
import {
  type DropdownState,
  getDropdownOpenState,
  useDropdown,
} from '../../composables/useDropdown';
import { useChatStore } from '../../stores/chat';
import { useModelsStore } from '../../stores/models';

const props = withDefaults(
  defineProps<{
    isStreaming: boolean;
    dropdown?: DropdownState;
  }>(),
  {
    dropdown: undefined,
  },
);

const modelsStore = useModelsStore();
const ownDropdown = useDropdown(false);
const dropdown = computed<DropdownState>(() => props.dropdown ?? ownDropdown);
const isOpen = computed(() => getDropdownOpenState(dropdown.value));

const availableModels = computed(() =>
  modelsStore.switchableModelOptions.filter((m) => modelsStore.hasKey(m.provider)),
);

const currentModelLabel = computed(() => {
  const model = availableModels.value.find(
    (option) =>
      option.model === modelsStore.activeModel && option.provider === modelsStore.activeProvider,
  );
  return model?.label ?? `${modelsStore.activeProvider}/${modelsStore.activeModel}`;
});

async function selectModel(option: { provider: string; model: string }): Promise<void> {
  const chatStore = useChatStore();
  const msgCount = chatStore.messages.length;
  if (msgCount > 0) {
    dropdown.value.close();
    const confirmed = await bridge.confirm(
      '切换模型',
      `当前对话已有 ${msgCount} 条消息，切换模型会将全部上下文重新导入新模型，可能产生额外 Token 费用。确认切换到 ${option.model}？`,
    );
    if (!confirmed) return;
  }
  modelsStore.selectModel(option.provider, option.model);
  dropdown.value.close();
  if (msgCount > 0) {
    chatStore.setModelSwitchNotice(`已切换至 ${option.model}，后续对话将使用新模型。`);
  }
}

function toggle(): void {
  if (props.isStreaming) return;
  if (isOpen.value) {
    dropdown.value.close();
  } else {
    dropdown.value.open();
  }
}

defineExpose({
  toggle,
  close: dropdown.value.close,
  get isOpen() {
    return isOpen.value;
  },
});
</script>

<template>
  <div class="control-dropdown model-dropdown" :class="{ open: isOpen }">
    <button
      class="toolbar-btn model-btn"
      type="button"
      :class="{ 'model-btn-disabled': props.isStreaming }"
      :aria-expanded="isOpen"
      aria-haspopup="menu"
      :title="props.isStreaming ? '回答中无法切换模型' : '切换模型'"
      @click="toggle"
    >
      <span class="btn-label">{{ currentModelLabel }}</span>
      <span class="chevron" aria-hidden="true">⌄</span>
    </button>
    <div v-if="isOpen" class="dropdown-menu model-menu" role="menu">
      <button
        v-for="model in availableModels"
        :key="`${model.provider}/${model.model}`"
        class="dropdown-item"
        :class="{
          active:
            model.model === modelsStore.activeModel &&
            model.provider === modelsStore.activeProvider,
        }"
        type="button"
        role="menuitem"
        @click="selectModel(model)"
      >
        <span class="item-label">{{ model.label }}</span>
        <span class="item-provider">{{ model.provider }}</span>
      </button>
      <div v-if="availableModels.length === 0" class="empty-models">
        请先在设置中配置供应商 Key
      </div>
    </div>
  </div>
</template>

<style scoped>
.control-dropdown {
  position: relative;
  min-width: 0;
}

.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.08s ease, color 0.08s ease;
}

.toolbar-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.btn-label {
  white-space: nowrap;
  font-weight: 500;
}

.chevron {
  font-size: 11px;
  color: var(--color-text-muted);
}

.model-btn {
  min-width: 100px;
  justify-content: center;
}

.model-btn-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.model-btn-disabled:hover {
  background: transparent;
  color: var(--color-text-secondary);
}

.dropdown-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  min-width: 190px;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border-color-strong);
  border-radius: 12px;
  background: var(--color-bg);
  box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.2);
  z-index: 100;
}

.model-menu {
  min-width: 200px;
}

.model-menu .item-provider {
  font-size: 10px;
  color: var(--color-text-muted);
}

.empty-models {
  padding: 10px 12px;
  color: var(--color-text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 11px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  text-align: left;
  transition: background 0.08s ease, color 0.08s ease;
}

.dropdown-item:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.dropdown-item.active {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent);
  font-weight: 550;
}

.item-info {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.item-label {
  white-space: nowrap;
}
</style>
