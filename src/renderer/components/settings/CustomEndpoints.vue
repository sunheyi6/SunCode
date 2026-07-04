<script setup lang="ts">
import type { CustomApiFormat, CustomEndpoint } from '@shared/types';
import { computed, ref } from 'vue';
import { BUILTIN_PROVIDERS, useModelsStore } from '../../stores/models';
import { useSettingsStore } from '../../stores/settings';
import { type EndpointForm, generateEndpointId, validateEndpoint } from './custom-endpoints';

const settingsStore = useSettingsStore();
const modelsStore = useModelsStore();

const endpoints = computed<CustomEndpoint[]>(() => settingsStore.settings.customEndpoints ?? []);

// 编辑态：null = 列表态；-1 = 新建；>=0 = 编辑该索引
const editingIndex = ref<number | null>(null);
const form = ref<EndpointForm>(emptyForm());
const errors = ref<string[]>([]);

const API_FORMATS: { value: CustomApiFormat; label: string }[] = [
  { value: 'openai-completions', label: 'OpenAI Completions（兼容）' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
];

function emptyForm(): EndpointForm {
  return {
    name: '',
    baseUrl: '',
    apiKey: '',
    apiFormat: 'openai-completions',
    models: [{ id: '', name: '', contextWindow: '' }],
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
  editingIndex.value = null;
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
      baseUrl: form.value.baseUrl.trim(),
      apiKey: form.value.apiKey.trim(),
      apiFormat: form.value.apiFormat,
      models,
    };
    await persist([...current, ep]);
  } else {
    const i = editingIndex.value;
    const ep: CustomEndpoint = {
      id: current[i]!.id, // 编辑时保留原 id
      name: form.value.name.trim(),
      baseUrl: form.value.baseUrl.trim(),
      apiKey: form.value.apiKey.trim(),
      apiFormat: form.value.apiFormat,
      models,
    };
    const next = [...current];
    next[i] = ep;
    await persist(next);
  }

  editingIndex.value = null;
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
</script>

<template>
  <div class="custom-endpoints">
    <div class="ce-header">
      <h4>自定义端点</h4>
      <p class="ce-desc">接入任意 OpenAI / Anthropic 兼容端点。URL、Key 仅存本地。</p>
    </div>

    <!-- 列表态 -->
    <div v-if="editingIndex === null" class="ce-list">
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

      <div v-if="endpoints.length === 0" class="ce-empty">尚未配置自定义端点。</div>

      <button class="ce-add" @click="startCreate">+ 添加端点</button>
    </div>

    <!-- 编辑态 -->
    <div v-else class="ce-form">
      <label class="ce-row">
        <span>显示名</span>
        <input v-model="form.name" placeholder="如：我的内网网关" />
      </label>

      <label class="ce-row">
        <span>Base URL</span>
        <input v-model="form.baseUrl" placeholder="https://gw.example.com/v1" />
      </label>

      <label class="ce-row">
        <span>API Key</span>
        <input v-model="form.apiKey" type="password" placeholder="sk-..." />
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
          <input v-model="m.id" placeholder="模型 id *" class="ce-m-id" />
          <input v-model="m.name" placeholder="显示名(可选)" class="ce-m-name" />
          <input v-model="m.contextWindow" placeholder="上下文(可选, 默认128000)" class="ce-m-ctx" />
          <button class="ce-btn danger" @click="removeModelRow(i)">✕</button>
        </div>
        <button class="ce-add-sm" @click="addModelRow">+ 添加模型</button>
      </div>

      <div v-if="errors.length" class="ce-errors">
        <div v-for="err in errors" :key="err">{{ err }}</div>
      </div>

      <div class="ce-form-actions">
        <button class="ce-btn primary" @click="save">保存</button>
        <button class="ce-btn" @click="cancelEdit">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.custom-endpoints { display: flex; flex-direction: column; gap: 10px; margin-top: 18px; }
.ce-header h4 { font-size: 13px; font-weight: 600; margin: 0 0 2px; color: var(--color-text); }
.ce-desc { font-size: 12px; color: var(--color-text-muted); margin: 0; }
.ce-list { display: flex; flex-direction: column; gap: 6px; }
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
.ce-add { align-self: flex-start; padding: 5px 12px; font-size: 12px; background: var(--color-accent); color: var(--color-bg); border: none; border-radius: var(--border-radius-sm); cursor: pointer; }
.ce-add:hover { opacity: 0.9; }

.ce-form { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--color-accent); border-radius: var(--border-radius); background: color-mix(in srgb, var(--color-accent) 5%, var(--color-surface)); }
.ce-row { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--color-text-secondary); }
.ce-row input, .ce-row select { padding: 5px 8px; font-size: 12px; background: var(--color-bg-tertiary); border: 1px solid var(--border-color); border-radius: 3px; color: var(--color-text); outline: none; }
.ce-row input:focus, .ce-row select:focus { border-color: var(--color-accent); }
.ce-models { display: flex; flex-direction: column; gap: 6px; }
.ce-models-title { font-size: 12px; color: var(--color-text-secondary); }
.ce-model-row { display: flex; gap: 4px; }
.ce-model-row input { padding: 4px 6px; font-size: 12px; background: var(--color-bg-tertiary); border: 1px solid var(--border-color); border-radius: 3px; color: var(--color-text); outline: none; }
.ce-model-row input:focus { border-color: var(--color-accent); }
.ce-m-id { flex: 2; } .ce-m-name { flex: 2; } .ce-m-ctx { flex: 2; }
.ce-add-sm { align-self: flex-start; padding: 3px 10px; font-size: 11px; border: 1px solid var(--border-color); background: var(--color-bg-tertiary); color: var(--color-text-secondary); border-radius: 3px; cursor: pointer; }
.ce-errors { color: var(--color-red); font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.ce-form-actions { display: flex; gap: 6px; }
.ce-btn { padding: 4px 10px; font-size: 11px; border: 1px solid var(--border-color); background: var(--color-bg-tertiary); color: var(--color-text-secondary); border-radius: 3px; cursor: pointer; }
.ce-btn:hover { background: var(--color-surface-hover); color: var(--color-text); }
.ce-btn.primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-bg); }
.ce-btn.danger { color: var(--color-red); border-color: transparent; background: transparent; }
.ce-btn.danger:hover { background: color-mix(in srgb, var(--color-red) 15%, transparent); }
</style>