<script setup lang="ts">
import type { MemoryEntry } from '@shared/types';
import { ref } from 'vue';
import { bridge } from '../../api/bridge';
import { useToast } from '../../composables/useToast';
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import AppIcon from '../icons/AppIcon.vue';

const props = withDefaults(
  defineProps<{
    visible: boolean;
  }>(),
  {
    visible: false,
  },
);

const emit = defineEmits<{
  close: [];
  saved: [];
}>();

const { showToast } = useToast();

// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const kindLabels: Record<string, string> = {
  task_summary: '任务摘要',
  project_fact: '项目事实',
  decision: '决策',
  preference: '偏好',
  lesson: '经验教训',
  ephemeral: '临时',
};

const newMemory = ref({
  userRequest: '',
  summary: '',
  kind: 'task_summary',
  scope: 'project' as 'session' | 'project' | 'global',
  importance: 1,
  tags: '',
});

const isAddingMemory = ref(false);

async function handleSubmit(): Promise<void> {
  if (!newMemory.value.userRequest.trim()) {
    showToast('请输入记忆内容', 'error');
    return;
  }

  isAddingMemory.value = true;
  try {
    const workingDir = await bridge.getWorkingDir();
    const memory: MemoryEntry = {
      date: new Date().toISOString().slice(0, 10),
      slug: `manual-${Date.now()}`,
      userRequest: newMemory.value.userRequest,
      toolsUsed: {},
      summary: newMemory.value.summary,
      kind: newMemory.value.kind,
      scope: newMemory.value.scope,
      importance: newMemory.value.importance,
      tags: newMemory.value.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    };
    await bridge.saveMemory(workingDir, memory);
    showToast('记忆已添加', 'success');
    newMemory.value = {
      userRequest: '',
      summary: '',
      kind: 'task_summary',
      scope: 'project',
      importance: 1,
      tags: '',
    };
    emit('saved');
    emit('close');
  } catch (e) {
    showToast('添加记忆失败', 'error');
    console.error('[MemoryAddDialog] saveMemory failed:', e);
  } finally {
    isAddingMemory.value = false;
  }
}

function handleClose(): void {
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" class="memory-add-modal" @click.self="handleClose">
        <section
          class="memory-add"
          role="dialog"
          aria-modal="true"
          aria-labelledby="memory-add-title"
        >
          <header class="add-header">
            <div class="header-title">
              <span class="header-icon" aria-hidden="true"><AppIcon name="plus" :size="16" /></span>
              <div>
                <span class="eyebrow">NEW MEMORY</span>
                <strong id="memory-add-title">添加新记忆</strong>
              </div>
            </div>
            <button class="action-btn" type="button" title="关闭" aria-label="关闭" @click="handleClose">
              <AppIcon name="x" :size="14" />
            </button>
          </header>

          <form class="add-body" @submit.prevent="handleSubmit">
            <label class="add-field">
              <span>内容</span>
              <textarea
                v-model="newMemory.userRequest"
                rows="4"
                placeholder="例如：项目使用 Bun 管理依赖"
              />
            </label>

            <label class="add-field">
              <span>摘要 <em>可选</em></span>
              <input v-model="newMemory.summary" type="text" placeholder="用一句话概括这条记忆" />
            </label>

            <div class="add-field-grid">
              <label class="add-field">
                <span>类型</span>
                <select v-model="newMemory.kind">
                  <option v-for="(label, key) in kindLabels" :key="key" :value="key">
                    {{ label }}
                  </option>
                </select>
              </label>
              <label class="add-field">
                <span>作用域</span>
                <select v-model="newMemory.scope">
                  <option value="session">会话级</option>
                  <option value="project">项目级</option>
                  <option value="global">全局级</option>
                </select>
              </label>
            </div>

            <label class="add-field">
              <span>重要度 <strong class="add-range-value">{{ newMemory.importance }}/5</strong></span>
              <input v-model.number="newMemory.importance" type="range" min="1" max="5" />
            </label>

            <label class="add-field">
              <span>标签 <em>可选</em></span>
              <input v-model="newMemory.tags" type="text" placeholder="用逗号分隔多个标签" />
            </label>

            <div class="add-footer">
              <button class="cancel-button" type="button" @click="handleClose">取消</button>
              <button class="submit-button" type="submit" :disabled="isAddingMemory">
                <AppIcon :name="isAddingMemory ? 'loader' : 'plus'" :size="14" />
                {{ isAddingMemory ? '添加中...' : '添加记忆' }}
              </button>
            </div>
          </form>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.memory-add-modal {
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

.memory-add {
  width: min(560px, 92vw);
  max-height: min(760px, 86vh);
  overflow: hidden;
  border: 1px solid var(--border-color-strong);
  border-radius: var(--border-radius-xl);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
}

.add-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px;
  border-bottom: 1px solid var(--border-color);
}

.header-title,
.header-title > div {
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
.eyebrow { color: var(--color-text-muted); font-size: 10px; font-weight: 650; letter-spacing: 0.08em; }
.header-title strong { color: var(--color-text); font-size: 15px; font-weight: 650; }

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

.add-body { max-height: calc(min(760px, 86vh) - 70px); overflow-y: auto; padding: 22px; display: flex; flex-direction: column; gap: 16px; }

.add-field { display: flex; flex-direction: column; gap: 6px; }
.add-field > span { color: var(--color-text-secondary); font-size: 12px; font-weight: 600; }
.add-field em { color: var(--color-text-muted); font-size: 11px; font-style: normal; font-weight: 400; }
.add-field input,
.add-field textarea,
.add-field select {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 11px;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
}
.add-field input:focus,
.add-field textarea:focus,
.add-field select:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 12%, transparent);
  outline: none;
}
.add-field textarea { min-height: 92px; resize: vertical; line-height: 1.5; }
.add-field select { height: 38px; padding: 0 10px; }
.add-field-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }

.add-field input[type='range'] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 5px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-muted) 28%, var(--color-bg-tertiary));
  box-shadow: none;
}
.add-field input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border: 0;
  border-radius: 50%;
  background: var(--color-accent);
  cursor: pointer;
}
.add-field input[type='range']::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border: 0;
  border-radius: 50%;
  background: var(--color-accent);
  cursor: pointer;
}
.add-range-value { float: right; color: var(--color-text); font-family: var(--font-mono); font-size: 11px; font-weight: 600; }

.add-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
.cancel-button {
  display: inline-flex;
  align-items: center;
  height: 36px;
  padding: 0 16px;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.cancel-button:hover { background: var(--color-surface-hover); color: var(--color-text); }
.submit-button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 18px;
  border: 0;
  border-radius: var(--border-radius-sm);
  background: var(--color-accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.submit-button:hover:not(:disabled) { background: var(--color-accent-hover); }
.submit-button:disabled { opacity: 0.6; cursor: default; }

.modal-enter-active, .modal-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; transform: translateY(8px) scale(0.98); }

@media (max-width: 540px) {
  .add-field-grid { grid-template-columns: 1fr; }
}
</style>
