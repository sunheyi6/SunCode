<script setup lang="ts">
import type { MemoryEntry, StructuredFact } from '@shared/types';
import { computed } from 'vue';
import { bridge } from '../../api/bridge';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';

const props = withDefaults(
  defineProps<{
    memory: MemoryEntry;
    visible: boolean;
    showDelete?: boolean;
  }>(),
  {
    showDelete: true,
  },
);

const emit = defineEmits<{
  close: [];
  delete: [];
}>();

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const kindLabels: Record<string, string> = {
  task_summary: '任务摘要',
  project_fact: '项目事实',
  decision: '决策',
  preference: '偏好',
  lesson: '经验教训',
  ephemeral: '临时',
};

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const kindColors: Record<string, string> = {
  task_summary: 'var(--color-accent)',
  project_fact: 'var(--color-teal)',
  decision: 'var(--color-purple)',
  preference: 'var(--color-green)',
  lesson: 'var(--color-orange)',
  ephemeral: 'var(--color-text-muted)',
};

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const scopeLabels: Record<string, string> = {
  global: '全局级',
  project: '项目级',
  session: '会话级',
};

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const scopeColors: Record<string, string> = {
  global: 'var(--color-purple)',
  project: 'var(--color-teal)',
  session: 'var(--color-text-muted)',
};

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const formattedDate = computed(() => {
  const date = new Date(props.memory.date);
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
});

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const formattedUpdatedAt = computed(() => {
  if (!props.memory.updatedAt) return '';
  return new Date(props.memory.updatedAt).toLocaleString('zh-CN');
});

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const toolList = computed(() =>
  Object.entries(props.memory.toolsUsed).map(([name, count]) => ({ name, count })),
);

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
async function handleDelete(): Promise<void> {
  const confirmed = await bridge.confirm('删除记忆', '确定要删除这条记忆吗？');
  if (confirmed) emit('delete');
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function formatFact(fact: StructuredFact): string {
  const validity = fact.validity.end
    ? `(${fact.validity.start} ~ ${fact.validity.end})`
    : `(${fact.validity.start}起)`;
  return `${fact.subject} ${fact.predicate} ${fact.object} ${validity}`;
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" class="memory-detail-modal" @click.self="emit('close')">
        <section class="memory-detail" role="dialog" aria-modal="true" aria-labelledby="memory-detail-title">
          <header class="detail-header">
            <div class="header-title">
              <span class="header-icon" aria-hidden="true"><AppIcon name="brain" :size="16" /></span>
              <div>
                <span class="eyebrow">记忆详情</span>
                <span class="header-date">{{ formattedDate }}</span>
              </div>
            </div>
            <div class="header-actions">
              <button
                v-if="showDelete"
                class="action-btn delete-btn"
                type="button"
                title="删除记忆"
                aria-label="删除记忆"
                @click="handleDelete"
              >
                <AppIcon name="trash" :size="14" />
              </button>
              <button
                class="action-btn"
                type="button"
                title="关闭"
                aria-label="关闭"
                @click="emit('close')"
              >
                <AppIcon name="x" :size="14" />
              </button>
            </div>
          </header>

          <div class="detail-body">
            <div class="detail-badges">
              <span
                class="kind-badge"
                :style="{
                  backgroundColor: `${kindColors[memory.kind || 'task_summary']}20`,
                  color: kindColors[memory.kind || 'task_summary'],
                  borderColor: kindColors[memory.kind || 'task_summary'],
                }"
              >
                {{ kindLabels[memory.kind || 'task_summary'] }}
              </span>
              <span
                v-if="memory.scope"
                class="scope-badge"
                :style="{
                  borderColor: scopeColors[memory.scope],
                  color: scopeColors[memory.scope],
                }"
              >
                {{ scopeLabels[memory.scope] }}
              </span>
            </div>

            <h2 id="memory-detail-title" class="memory-title">{{ memory.userRequest }}</h2>

            <div class="detail-section summary-section">
              <h3>摘要</h3>
              <p class="summary-text">{{ memory.summary || '暂无摘要' }}</p>
            </div>

            <div v-if="toolList.length > 0" class="detail-section">
              <h3>工具使用</h3>
              <div class="tools-grid">
                <span v-for="tool in toolList" :key="tool.name" class="tool-tag">
                  {{ tool.name }} × {{ tool.count }}
                </span>
              </div>
            </div>

            <div v-if="memory.tags && memory.tags.length > 0" class="detail-section">
              <h3>标签</h3>
              <div class="tags-grid">
                <span v-for="tag in memory.tags" :key="tag" class="tag-item">#{{ tag }}</span>
              </div>
            </div>

            <div v-if="memory.facts && memory.facts.length > 0" class="detail-section">
              <h3>结构化事实</h3>
              <ul class="facts-list">
                <li v-for="(fact, index) in memory.facts" :key="index">
                  <span class="fact-type">{{ fact.type }}</span>
                  <span class="fact-content">{{ formatFact(fact) }}</span>
                  <span class="fact-confidence">{{ Math.round(fact.confidence * 100) }}%</span>
                </li>
              </ul>
            </div>

            <div class="detail-section metadata">
              <h3>元数据</h3>
              <div class="metadata-grid">
                <div class="metadata-item">
                  <span class="meta-label">重要性</span>
                  <span class="meta-value">{{ memory.importance || 1 }}/5</span>
                </div>
                <div class="metadata-item">
                  <span class="meta-label">访问次数</span>
                  <span class="meta-value">{{ memory.accessCount || 0 }}</span>
                </div>
                <div v-if="memory.pinned" class="metadata-item">
                  <span class="meta-label">置顶</span>
                  <span class="meta-value">是</span>
                </div>
                <div v-if="memory.validFrom" class="metadata-item">
                  <span class="meta-label">生效时间</span>
                  <span class="meta-value">{{ memory.validFrom }}</span>
                </div>
                <div v-if="memory.expiresAt" class="metadata-item">
                  <span class="meta-label">过期时间</span>
                  <span class="meta-value">{{ memory.expiresAt }}</span>
                </div>
                <div v-if="formattedUpdatedAt" class="metadata-item">
                  <span class="meta-label">更新时间</span>
                  <span class="meta-value">{{ formattedUpdatedAt }}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.memory-detail-modal {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--color-bg) 54%, transparent);
  backdrop-filter: blur(8px);
}

.memory-detail {
  width: min(640px, 92vw);
  max-height: min(760px, 86vh);
  overflow: hidden;
  border: 1px solid var(--border-color-strong);
  border-radius: var(--border-radius-xl);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px;
  border-bottom: 1px solid var(--border-color);
}

.header-title,
.header-title > div,
.header-actions,
.detail-badges,
.tools-grid,
.tags-grid {
  display: flex;
  align-items: center;
}

.header-title { gap: 10px; }
.header-icon {
  display: inline-flex;
  padding: 8px;
  border-radius: var(--border-radius);
  background: color-mix(in srgb, var(--color-accent) 14%, var(--color-surface));
  color: var(--color-accent);
}
.header-title > div { align-items: flex-start; flex-direction: column; gap: 1px; }
.eyebrow { color: var(--color-text); font-size: 13px; font-weight: 650; }
.header-date { color: var(--color-text-muted); font-family: var(--font-mono); font-size: 11px; }
.header-actions { gap: 4px; }

.action-btn {
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--border-radius);
  background: transparent;
  color: var(--color-text-muted);
}
.action-btn:hover { background: var(--color-surface-hover); color: var(--color-text); }
.delete-btn:hover { background: color-mix(in srgb, var(--color-red) 12%, transparent); color: var(--color-red); }

.detail-body { max-height: calc(min(760px, 86vh) - 70px); overflow-y: auto; padding: 22px; }
.detail-badges { gap: 7px; margin-bottom: 12px; }
.kind-badge,
.scope-badge {
  padding: 4px 9px;
  border: 1px solid;
  border-radius: var(--border-radius-pill);
  font-size: 11px;
  font-weight: 650;
}
.scope-badge { border-color: var(--border-color); background: var(--color-bg-tertiary); color: var(--color-text-muted); }
.memory-title { margin: 0 0 22px; color: var(--color-text); font-size: 21px; font-weight: 700; line-height: 1.35; }
.detail-section { margin-top: 20px; }
.detail-section h3 { margin: 0 0 9px; color: var(--color-text-secondary); font-size: 12px; font-weight: 650; letter-spacing: 0.04em; }
.summary-section { margin-top: 0; padding: 14px 16px; border: 1px solid var(--border-color); border-radius: var(--border-radius); background: var(--color-bg-secondary); }
.summary-text { margin: 0; color: var(--color-text); font-size: 14px; line-height: 1.65; white-space: pre-wrap; }
.tools-grid, .tags-grid { flex-wrap: wrap; gap: 7px; }
.tool-tag, .tag-item { padding: 5px 9px; border-radius: var(--border-radius-sm); font-size: 12px; }
.tool-tag { background: color-mix(in srgb, var(--color-accent) 11%, var(--color-surface)); color: var(--color-accent); }
.tag-item { background: var(--color-bg-tertiary); color: var(--color-text-secondary); }
.facts-list { margin: 0; padding: 0; list-style: none; }
.facts-list li { display: flex; align-items: flex-start; gap: 8px; padding: 9px 0; border-bottom: 1px solid var(--border-color); }
.facts-list li:last-child { border-bottom: 0; }
.fact-type { flex: 0 0 auto; padding: 2px 6px; border-radius: 4px; background: var(--color-bg-tertiary); color: var(--color-text-muted); font-size: 10px; }
.fact-content { flex: 1; color: var(--color-text); font-size: 13px; line-height: 1.45; }
.fact-confidence { flex: 0 0 auto; color: var(--color-text-muted); font-size: 11px; }
.metadata { padding-top: 16px; border-top: 1px solid var(--border-color); }
.metadata-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
.metadata-item { display: flex; flex-direction: column; gap: 3px; }
.meta-label { color: var(--color-text-muted); font-size: 11px; }
.meta-value { color: var(--color-text-secondary); font-size: 13px; }
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; transform: translateY(8px) scale(0.98); }
</style>
