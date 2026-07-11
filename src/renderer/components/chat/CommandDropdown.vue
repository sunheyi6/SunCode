<script setup lang="ts">
/**
 * Command Dropdown — appears when the user types "/" in the chat input.
 * Rendered via Teleport to body for z-index isolation.
 * Shows fuzzy-matched slash commands with keyboard navigation.
 */

import { type CommandMatch, matchCommands, type SlashCommand } from '@shared/commands';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';

const props = defineProps<{
  inputText: string;
  visible: boolean;
  commands: readonly SlashCommand[];
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

const matches = computed<CommandMatch[]>(() =>
  matchCommands(query.value, props.commands).sort(
    (a, b) => Number(Boolean(a.command.isSkill)) - Number(Boolean(b.command.isSkill)),
  ),
);
const hasMatches = computed(() => matches.value.length > 0);
const builtinMatches = computed(() => matches.value.filter((match) => !match.command.isSkill));
const skillMatches = computed(() => matches.value.filter((match) => match.command.isSkill));

const dropdownStyle = computed(() => {
  if (!props.anchorRect) return { display: 'none' };
  return {
    position: 'fixed' as const,
    left: `${props.anchorRect.left}px`,
    bottom: `${window.innerHeight - props.anchorRect.top + 8}px`,
    width: `${props.anchorRect.width}px`,
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
      e.preventDefault();
      e.stopPropagation();
      selectPrev();
      break;
    case 'ArrowDown':
      e.preventDefault();
      e.stopPropagation();
      selectNext();
      break;
    case 'Enter':
    case 'Tab':
      e.preventDefault();
      e.stopPropagation();
      confirmSelection();
      break;
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      emit('close');
      break;
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown, true));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown, true));

watch(matches, () => {
  selectedIndex.value = 0;
});

// ===== Highlight =====

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function commandLabel(command: SlashCommand): string {
  return command.label || `/${command.name}`;
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
          v-for="(m, idx) in builtinMatches"
          :key="m.command.name"
          class="cmd-item"
          :class="{ sel: idx === selectedIndex }"
          @click="onItemClick(m.command)"
          @mouseenter="selectedIndex = idx"
        >
          <span class="cmd-icon"><AppIcon :name="m.command.icon" :size="15" /></span>
          <span class="cmd-body">
            <span class="cmd-name">{{ commandLabel(m.command) }}</span>
            <span class="cmd-desc">{{ m.command.description }}</span>
          </span>
        </button>
        <p v-if="skillMatches.length > 0" class="cmd-section-title">技能</p>
        <button
          v-for="(m, skillIndex) in skillMatches"
          :key="m.command.name"
          class="cmd-item"
          :class="{ sel: builtinMatches.length + skillIndex === selectedIndex }"
          @click="onItemClick(m.command)"
          @mouseenter="selectedIndex = builtinMatches.length + skillIndex"
        >
          <span class="cmd-icon"><AppIcon :name="m.command.icon" :size="16" /></span>
          <span class="cmd-body">
            <span class="cmd-name">{{ commandLabel(m.command) }}</span>
            <span class="cmd-desc">{{ m.command.description }}</span>
          </span>
          <span class="cmd-source">个人</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cmd-drop {
  z-index: 9999;
  display: flex;
  flex-direction: column;
  max-height: 390px;
  border: 0;
  border-radius: var(--border-radius-lg);
  background: var(--color-bg);
  box-shadow: none;
  overflow: hidden;
}

.cmd-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 10px 10px;
}

.cmd-item {
  display: flex;
  align-items: center;
  min-height: 36px;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: var(--border-radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.cmd-item:hover,
.cmd-item.sel {
  background: color-mix(in srgb, var(--color-surface-hover) 78%, transparent);
  color: var(--color-text);
}

.cmd-icon {
  display: inline-flex;
  width: 18px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
}

.cmd-body {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  flex: 1;
}

.cmd-name {
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 520;
  white-space: nowrap;
}

.cmd-desc {
  overflow: hidden;
  max-width: 100%;
  flex: 1;
  color: var(--color-text-muted);
  font-size: 14px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd-source {
  flex: 0 0 auto;
  color: var(--color-text-muted);
  font-size: 14px;
}

.cmd-section-title {
  margin: 14px 6px 7px;
  color: var(--color-text-muted);
  font-size: 14px;
}
</style>
