<script setup lang="ts">
/**
 * Command Dropdown — appears when the user types "/" in the chat input.
 * Rendered via Teleport to body for z-index isolation.
 * Shows fuzzy-matched slash commands with keyboard navigation.
 */
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { matchCommands, type CommandMatch, type SlashCommand } from '@shared/commands';

const props = defineProps<{
  inputText: string;
  visible: boolean;
  /** DOMRect of the textarea for positioning. */
  anchorRect: DOMRect | null;
}>();

const emit = defineEmits<{
  select: [command: SlashCommand];
  close: [];
}>();

// ===== State =====
const selectedIndex = ref(0);
const listRef = ref<HTMLElement | null>(null);

// ===== Computed =====

const query = computed(() => {
  const text = props.inputText;
  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  // Find last "/" at position 0 or after a space
  let slashIdx = -1;
  for (let i = 0; i < lastLine.length; i++) {
    if (lastLine[i] === '/') {
      if (i === 0 || lastLine[i - 1] === ' ') slashIdx = i;
    }
  }
  return slashIdx >= 0 ? lastLine.slice(slashIdx) : '';
});

const matches = computed<CommandMatch[]>(() => matchCommands(query.value));
const hasMatches = computed(() => matches.value.length > 0);

const dropdownStyle = computed(() => {
  if (!props.anchorRect) return { display: 'none' };
  return {
    position: 'fixed' as const,
    left: `${props.anchorRect.left}px`,
    bottom: `${window.innerHeight - props.anchorRect.top + 8}px`,
    width: `${props.anchorRect.width}px`,
    maxWidth: `${Math.min(props.anchorRect.width, 560)}px`,
  };
});

// ===== Keyboard =====

function selectPrev(): void {
  if (matches.value.length === 0) return;
  selectedIndex.value = (selectedIndex.value - 1 + matches.value.length) % matches.value.length;
}

function selectNext(): void {
  if (matches.value.length === 0) return;
  selectedIndex.value = (selectedIndex.value + 1) % matches.value.length;
}

function confirmSelection(): void {
  const match = matches.value[selectedIndex.value];
  if (match) emit('select', match.command);
}

function onItemClick(cmd: SlashCommand): void {
  emit('select', cmd);
}

function handleKeydown(e: KeyboardEvent): void {
  if (!props.visible || !hasMatches.value) return;

  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault(); e.stopPropagation();
      selectPrev();
      break;
    case 'ArrowDown':
      e.preventDefault(); e.stopPropagation();
      selectNext();
      break;
    case 'Enter':
    case 'Tab':
      e.preventDefault(); e.stopPropagation();
      confirmSelection();
      break;
    case 'Escape':
      e.preventDefault(); e.stopPropagation();
      emit('close');
      break;
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown, true));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown, true));

watch(matches, () => { selectedIndex.value = 0; });

// ===== Highlight =====

function highlightName(cmd: SlashCommand, indices: number[]): string {
  if (indices.length === 0) return `/${cmd.name}`;
  let html = '/';
  const s = new Set(indices);
  for (let i = 0; i < cmd.name.length; i++) {
    html += s.has(i) ? `<mark>${cmd.name[i]}</mark>` : cmd.name[i];
  }
  return html;
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible && hasMatches && anchorRect"
      class="cmd-drop"
      :style="dropdownStyle"
    >
      <div class="cmd-list" ref="listRef">
        <button
          v-for="(m, idx) in matches"
          :key="m.command.name"
          class="cmd-item"
          :class="{ sel: idx === selectedIndex }"
          @click="onItemClick(m.command)"
          @mouseenter="selectedIndex = idx"
        >
          <span class="cmd-icon">{{ m.command.icon }}</span>
          <span class="cmd-body">
            <span class="cmd-name" v-html="highlightName(m.command, m.matchIndices)" />
            <span v-if="m.command.argsLabel" class="cmd-args">{{ m.command.argsLabel }}</span>
          </span>
          <span class="cmd-desc">{{ m.command.description }}</span>
        </button>
      </div>
      <div class="cmd-foot">
        <kbd>↑↓</kbd> 导航 <kbd>Enter</kbd> 选择 <kbd>Esc</kbd> 关闭
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cmd-drop {
  z-index: 9999;
  display: flex;
  flex-direction: column;
  max-height: 220px;
  border: 1px solid var(--border-color-strong);
  border-radius: 12px;
  background: var(--color-bg);
  box-shadow: 0 4px 20px rgba(0,0,0,0.2);
  overflow: hidden;
}

.cmd-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.cmd-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.08s, color 0.08s;
}

.cmd-item:hover,
.cmd-item.sel {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent);
}

.cmd-icon { width: 20px; flex-shrink: 0; font-size: 15px; text-align: center; }

.cmd-body {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
  flex: 1;
}

.cmd-name {
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
}
.cmd-name :deep(mark) {
  background: transparent;
  color: var(--color-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.cmd-args {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cmd-desc {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}

.cmd-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  padding: 4px 10px;
  font-size: 10px;
  color: var(--color-text-muted);
  border-top: 1px solid var(--border-color);
}
.cmd-foot kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 4px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background: var(--color-surface);
  font-size: 10px;
  color: var(--color-text-muted);
}
</style>
