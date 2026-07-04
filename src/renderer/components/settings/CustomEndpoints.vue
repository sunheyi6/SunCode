<script setup lang="ts">
import { normalizeCustomEndpointBaseUrl } from '@shared/custom-endpoints';
import type { CustomApiFormat, CustomEndpoint } from '@shared/types';
import { computed, ref } from 'vue';
import { BUILTIN_PROVIDERS, useModelsStore } from '../../stores/models';
import { useSettingsStore } from '../../stores/settings';
import { type EndpointForm, generateEndpointId, validateEndpoint } from './custom-endpoints';

const settingsStore = useSettingsStore();
const modelsStore = useModelsStore();

const endpoints = computed<CustomEndpoint[]>(() => settingsStore.settings.customEndpoints ?? []);

// 编辑态：-1 = 新建；>=0 = 编辑该索引。新增表单默认常驻展示。
const editingIndex = ref(-1);
const form = ref<EndpointForm>(emptyForm());
const errors = ref<string[]>([]);

const API_FORMATS: { value: CustomApiFormat; label: string }[] = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions (/v1/chat/completions)' },
  { value: 'openai-responses', label: 'OpenAI Responses (/v1/responses)' },
  { value: 'anthropic-messages', label: 'Anthropic Messages (/v1/messages)' },
];

function emptyForm(): EndpointForm {
  return {
    name: '',
    baseUrl: '',
    apiKey: '',
    apiFormat: 'anthropic-messages',
    models: [],
  };
}

function startCreate(): void {
  editingIndex.value = -1;
  form.value = emptyForm();
  errors.value = [];
}

function startEdit(index: number): void {
  const e = endpoints.value[index];
  if (!e) return;
  editingIndex.value = index;
  form.value = {
    name: e.name,
    baseUrl: e.baseUrl,
    apiKey: e.apiKey,
    apiFormat: e.apiFormat,
    models: e.models.map((m) => ({
      id: m.id,
      name: m.name ?? '',
      contextWindow: m.contextWindow ? String(m.contextWindow) : '',
    })),
  };
  if (form.value.models.length === 0)
    form.value.models.push({ id: '', name: '', contextWindow: '' });
  errors.value = [];
}

function cancelEdit(): void {
  editingIndex.value = -1;
  form.value = emptyForm();
  errors.value = [];
}

function addModelRow(): void {
  form.value.models.push({ id: '', name: '', contextWindow: '' });
}

function removeModelRow(i: number): void {
  form.value.models.splice(i, 1);
}

async function persist(next: CustomEndpoint[]): Promise<void> {
  await settingsStore.update({ customEndpoints: next });
  modelsStore.syncCustomEndpoints(next);
}

async function save(): Promise<void> {
  const errs = validateEndpoint(form.value);
  if (errs.length) {
    errors.value = errs;
    return;
  }

  const models = form.value.models
    .filter((m) => m.id.trim())
    .map((m) => ({
      id: m.id.trim(),
      name: m.name.trim() || undefined,
      contextWindow: m.contextWindow.trim() ? Number(m.contextWindow) || undefined : undefined,
    }));

  const current = endpoints.value;
  if (editingIndex.value === -1) {
    const id = generateEndpointId(
      form.value.name,
      current.map((e) => e.id),
      BUILTIN_PROVIDERS,
    );
    const ep: CustomEndpoint = {
      id,
      name: form.value.name.trim(),
      baseUrl: normalizeCustomEndpointBaseUrl(form.value.baseUrl, form.value.apiFormat),
      apiKey: form.value.apiKey.trim(),
      apiFormat: form.value.apiFormat,
      models,
    };
    await persist([...current, ep]);
  } else {
    const i = editingIndex.value;
    const currentEndpoint = current[i];
    if (!currentEndpoint) return;
    const ep: CustomEndpoint = {
      id: currentEndpoint.id, // 编辑时保留原 id
      name: form.value.name.trim(),
      baseUrl: normalizeCustomEndpointBaseUrl(form.value.baseUrl, form.value.apiFormat),
      apiKey: form.value.apiKey.trim(),
      apiFormat: form.value.apiFormat,
      models,
    };
    const next = [...current];
    next[i] = ep;
    await persist(next);
  }

  editingIndex.value = -1;
  form.value = emptyForm();
  errors.value = [];
}

async function remove(index: number): Promise<void> {
  if (!confirm('删除该自定义端点？')) return;
  const next = endpoints.value.filter((_, i) => i !== index);
  await persist(next);
}

function apiFormatLabel(fmt: CustomApiFormat): string {
  return API_FORMATS.find((f) => f.value === fmt)?.label ?? fmt;
}

function formTitle(): string {
  return editingIndex.value === -1 ? '添加模型供应商' : '编辑模型供应商';
}

function formDescription(): string {
  return editingIndex.value === -1
    ? '配置一个完全自定义的 API 端点和初始模型。'
    : '修改该供应商的 API 端点、密钥和模型列表。';
}

function submitLabel(): string {
  return editingIndex.value === -1 ? '添加供应商' : '保存供应商';
}
</script>

<template>
  <div class="custom-endpoints">
    <div v-if="endpoints.length > 0" class="ce-list">
      <div class="ce-list-heading">
        <div>
          <h4>已添加供应商</h4>
          <p class="ce-desc">管理现有自定义 API 端点。</p>
        </div>
      </div>

      <div v-for="(e, i) in endpoints" :key="e.id" class="ce-card">
        <div class="ce-card-main">
          <strong>{{ e.name }}</strong>
          <span class="ce-url">{{ e.baseUrl }}</span>
          <div class="ce-meta">
            <span class="ce-tag">{{ apiFormatLabel(e.apiFormat) }}</span>
            <span class="ce-count">{{ e.models.length }} 个模型</span>
          </div>
        </div>
        <div class="ce-card-actions">
          <button class="ce-btn" @click="startEdit(i)">编辑</button>
          <button class="ce-btn danger" @click="remove(i)">删除</button>
        </div>
      </div>
    </div>

    <div class="ce-form">
      <div class="ce-form-header">
        <h4>{{ formTitle() }}</h4>
        <p class="ce-desc">{{ formDescription() }}</p>
      </div>

      <label class="ce-row">
        <span>名称</span>
        <input v-model="form.name" placeholder="如：智谱 GLM" />
      </label>

      <label class="ce-row">
        <span>Base URL</span>
        <input v-model="form.baseUrl" placeholder="https://api.example.com/v1" />
      </label>

      <label class="ce-row">
        <span>API Key</span>
        <input v-model="form.apiKey" type="password" placeholder="输入 API Key" />
      </label>

      <label class="ce-row">
        <span>API 格式</span>
        <select v-model="form.apiFormat">
          <option v-for="f in API_FORMATS" :key="f.value" :value="f.value">{{ f.label }}</option>
        </select>
      </label>

      <div class="ce-models">
        <div class="ce-models-title">模型列表</div>
        <div v-for="(m, i) in form.models" :key="i" class="ce-model-row">
          <input v-model="m.id" placeholder="模型 ID *" class="ce-m-id" />
          <input v-model="m.name" placeholder="显示名（可选）" class="ce-m-name" />
          <input v-model="m.contextWindow" placeholder="上下文（可选）" class="ce-m-ctx" />
          <button class="ce-btn danger" @click="removeModelRow(i)">✕</button>
        </div>
        <button class="ce-add-sm" @click="addModelRow">+ 添加模型</button>
      </div>

      <div v-if="errors.length" class="ce-errors">
        <div v-for="err in errors" :key="err">{{ err }}</div>
      </div>

      <div class="ce-form-actions">
        <button class="ce-btn primary" @click="save">{{ submitLabel() }}</button>
        <button v-if="editingIndex !== -1" class="ce-btn" @click="cancelEdit">取消</button>
        <button v-else class="ce-btn" @click="startCreate">清空</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.custom-endpoints { display: flex; flex-direction: column; gap: 12px; margin-top: 18px; }
.ce-list-heading,
.ce-form-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.ce-form-header {
  flex-direction: column;
  gap: 6px;
  margin-bottom: 6px;
}
.ce-list-heading h4,
.ce-form-header h4 {
  margin: 0 0 6px;
  color: var(--color-text);
  font-size: 20px;
  font-weight: 700;
}
.ce-desc { font-size: 12px; color: var(--color-text-muted); margin: 0; }
.ce-list { display: flex; flex-direction: column; gap: 8px; }
.ce-card {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 10px 12px; border: 1px solid var(--border-color); border-radius: var(--border-radius-sm);
  background: var(--color-surface);
}
.ce-card-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.ce-card-main strong { font-size: 13px; color: var(--color-text); }
.ce-url { font-size: 11px; color: var(--color-text-muted); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ce-meta { display: flex; gap: 8px; align-items: center; }
.ce-tag { font-size: 10px; padding: 1px 6px; border-radius: 6px; background: color-mix(in srgb, var(--color-accent) 15%, transparent); color: var(--color-accent); }
.ce-count { font-size: 10px; color: var(--color-text-muted); }
.ce-card-actions { display: flex; gap: 4px; flex-shrink: 0; }
.ce-empty { padding: 16px; text-align: center; color: var(--color-text-muted); font-size: 12px; border: 1px dashed var(--border-color); border-radius: var(--border-radius-sm); }
.ce-add {
  flex: 0 0 auto;
  align-self: flex-start;
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: var(--color-accent);
  color: var(--color-bg);
  cursor: pointer;
  font-size: 13px;
}
.ce-add:hover { opacity: 0.9; }

.ce-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 0;
  border: 0;
  background: transparent;
}
.ce-row { display: flex; flex-direction: column; gap: 8px; font-size: 14px; color: var(--color-text-secondary); }
.ce-row input, .ce-row select {
  width: 100%;
  height: 40px;
  padding: 0 14px;
  border: 1px solid var(--border-color-strong);
  border-radius: 8px;
  background: var(--color-surface);
  color: var(--color-text);
  outline: none;
  font-size: 14px;
}
.ce-row input:focus, .ce-row select:focus { border-color: var(--color-accent); }
.ce-row input::placeholder { color: var(--color-text-muted); }
.ce-models { display: flex; flex-direction: column; gap: 8px; }
.ce-models-title { font-size: 14px; color: var(--color-text-secondary); }
.ce-model-row { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr) auto; gap: 6px; }
.ce-model-row input {
  min-width: 0;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--color-surface);
  color: var(--color-text);
  outline: none;
  font-size: 13px;
}
.ce-model-row input:focus { border-color: var(--color-accent); }
.ce-add-sm {
  align-self: flex-start;
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: var(--color-surface-hover);
  color: var(--color-text);
  cursor: pointer;
  font-size: 14px;
}
.ce-errors { color: var(--color-red); font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.ce-form-actions { display: flex; gap: 6px; }
.ce-btn { padding: 8px 12px; font-size: 13px; border: 1px solid var(--border-color); background: var(--color-bg-tertiary); color: var(--color-text-secondary); border-radius: 8px; cursor: pointer; }
.ce-btn:hover { background: var(--color-surface-hover); color: var(--color-text); }
.ce-btn.primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-bg); }
.ce-btn.danger { color: var(--color-red); border-color: transparent; background: transparent; }
.ce-btn.danger:hover { background: color-mix(in srgb, var(--color-red) 15%, transparent); }

@media (max-width: 760px) {
  .ce-list-heading { flex-direction: column; }
  .ce-add { width: 100%; }
  .ce-model-row { grid-template-columns: 1fr; }
  .ce-model-row .ce-btn { justify-self: flex-start; }
}
</style>
