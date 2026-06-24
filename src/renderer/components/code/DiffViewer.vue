<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  oldCode: string;
  newCode: string;
  filename?: string;
}>();

interface DiffLine {
  type: 'context' | 'added' | 'removed';
  oldLineNum?: number;
  newLineNum?: number;
  text: string;
}

const diffLines = computed<DiffLine[]>(() => computeDiff(props.oldCode, props.newCode));

const stats = computed(() => {
  const added = diffLines.value.filter((d) => d.type === 'added').length;
  const removed = diffLines.value.filter((d) => d.type === 'removed').length;
  return { added, removed };
});

const showLineNumbers = computed(() => {
  return diffLines.value.some((d) => d.oldLineNum !== undefined || d.newLineNum !== undefined);
});

// ── Diff algorithm (LCS-based, line-level) ──

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Edge cases
  if (oldLines.length === 0 && newLines.length === 0) return [];
  if (oldLines.length === 0) {
    return newLines.map((text, i) => ({ type: 'added' as const, newLineNum: i + 1, text }));
  }
  if (newLines.length === 0) {
    return oldLines.map((text, i) => ({ type: 'removed' as const, oldLineNum: i + 1, text }));
  }

  // Find common prefix
  let prefixEnd = 0;
  while (prefixEnd < oldLines.length && prefixEnd < newLines.length && oldLines[prefixEnd] === newLines[prefixEnd]) {
    prefixEnd++;
  }

  // Find common suffix (from the end, after the prefix region)
  let suffixStart = 0;
  const minRemaining = Math.min(oldLines.length - prefixEnd, newLines.length - prefixEnd);
  while (
    suffixStart < minRemaining &&
    oldLines[oldLines.length - 1 - suffixStart] === newLines[newLines.length - 1 - suffixStart]
  ) {
    suffixStart++;
  }

  const result: DiffLine[] = [];

  // Context before change (up to 3 lines)
  const contextBefore = Math.max(0, prefixEnd - 3);
  for (let i = contextBefore; i < prefixEnd; i++) {
    result.push({ type: 'context', oldLineNum: i + 1, newLineNum: i + 1, text: oldLines[i] });
  }

  // Removed lines
  const oldStart = prefixEnd;
  const oldEnd = oldLines.length - suffixStart;
  for (let i = oldStart; i < oldEnd; i++) {
    result.push({ type: 'removed', oldLineNum: i + 1, text: oldLines[i] });
  }

  // Added lines
  const newStart = prefixEnd;
  const newEnd = newLines.length - suffixStart;
  for (let i = newStart; i < newEnd; i++) {
    result.push({ type: 'added', newLineNum: i + 1, text: newLines[i] });
  }

  // Context after change (up to 3 lines)
  const contextAfterEnd = Math.min(oldLines.length, oldLines.length - suffixStart + 3);
  for (let i = oldLines.length - suffixStart; i < contextAfterEnd; i++) {
    result.push({ type: 'context', oldLineNum: i + 1, newLineNum: i + 1, text: oldLines[i] });
  }

  return result;
}
</script>

<template>
  <div class="diff-viewer">
    <div class="diff-header">
      <span class="diff-filename">{{ filename || '文件' }}</span>
      <span class="diff-stat added">+{{ stats.added }}</span>
      <span class="diff-stat removed">−{{ stats.removed }}</span>
    </div>
    <div class="diff-body">
      <table class="diff-table">
        <tbody>
          <tr
            v-for="(line, i) in diffLines"
            :key="i"
            class="diff-row"
            :class="line.type"
          >
            <td class="line-num old-num">{{ line.oldLineNum ?? '' }}</td>
            <td class="line-num new-num">{{ line.newLineNum ?? '' }}</td>
            <td class="line-sign">{{ line.type === 'added' ? '+' : line.type === 'removed' ? '−' : '' }}</td>
            <td class="line-content">
              <pre>{{ line.text }}</pre>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.diff-viewer {
  margin: 4px 0;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.45;
  transition: border-color 0.15s ease;
}

.diff-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: var(--color-surface);
  border-bottom: 1px solid var(--border-color);
}

.diff-filename {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
  flex: 1;
}

.diff-stat {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
}
.diff-stat.added {
  color: #2da44e;
  background: color-mix(in srgb, #2da44e 12%, transparent);
}
.diff-stat.removed {
  color: #e5534b;
  background: color-mix(in srgb, #e5534b 12%, transparent);
}

.diff-body {
  overflow-x: auto;
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
}

.diff-row.context {
  background: transparent;
}
.diff-row.added {
  background: color-mix(in srgb, #2da44e 10%, transparent);
}
.diff-row.removed {
  background: color-mix(in srgb, #e5534b 10%, transparent);
}

.line-num {
  width: 1%;
  min-width: 36px;
  padding: 0 8px;
  text-align: right;
  color: var(--color-text-muted);
  opacity: 0.5;
  user-select: none;
  vertical-align: top;
  border-right: 1px solid var(--border-color);
}

.line-sign {
  width: 16px;
  padding: 0 4px;
  text-align: center;
  user-select: none;
  font-weight: 700;
  vertical-align: top;
}

.diff-row.added .line-sign {
  color: #2da44e;
}
.diff-row.removed .line-sign {
  color: #e5534b;
}

.diff-row.added .line-num {
  border-color: color-mix(in srgb, #2da44e 20%, transparent);
}
.diff-row.removed .line-num {
  border-color: color-mix(in srgb, #e5534b 20%, transparent);
}

.line-content {
  padding: 0 6px;
  vertical-align: top;
}

.line-content pre {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre;
  background: transparent;
  border: none;
  padding: 0;
  color: var(--color-text);
}
</style>
