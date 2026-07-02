<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { bridge } from '../../api/bridge';

interface KeyEntry {
  provider: string;
  key: string;
  masked: string;
  hasKey: boolean;
  editing: boolean;
}

const keyEntries = ref<KeyEntry[]>([]);

// Custom provider state
const customProvider = ref('');
const customKey = ref('');

// Common providers with their display names
const commonProviders = [
  { id: 'openai', name: 'OpenAI', env: 'OPENAI_API_KEY' },
  { id: 'anthropic', name: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
  { id: 'google', name: 'Google (Gemini)', env: 'GEMINI_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', env: 'DEEPSEEK_API_KEY' },
  { id: 'xai', name: 'xAI (Grok)', env: 'XAI_API_KEY' },
  { id: 'groq', name: 'Groq', env: 'GROQ_API_KEY' },
  { id: 'mistral', name: 'Mistral', env: 'MISTRAL_API_KEY' },
  { id: 'openrouter', name: 'OpenRouter', env: 'OPENROUTER_API_KEY' },
  { id: 'together', name: 'Together AI', env: 'TOGETHER_API_KEY' },
  { id: 'fireworks', name: 'Fireworks', env: 'FIREWORKS_API_KEY' },
  { id: 'cerebras', name: 'Cerebras', env: 'CEREBRAS_API_KEY' },
];

onMounted(async () => {
  try {
    const settings = await bridge.getSettings();
    keyEntries.value = commonProviders.map((p) => {
      const hasKey = Boolean(settings.envApiKeys?.[p.id]);
      return {
        provider: p.id,
        key: '',
        masked: hasKey ? '•'.repeat(24) : '',
        hasKey,
        editing: false,
      };
    });
  } catch {
    keyEntries.value = commonProviders.map((p) => ({
      provider: p.id,
      key: '',
      masked: '',
      hasKey: false,
      editing: false,
    }));
  }
});

function startEdit(entry: KeyEntry): void {
  entry.editing = true;
  entry.key = '';
}

function cancelEdit(entry: KeyEntry): void {
  entry.editing = false;
  entry.key = '';
}

async function saveKey(entry: KeyEntry): Promise<void> {
  const key = entry.key.trim();
  if (!key) {
    entry.editing = false;
    return;
  }

  try {
    await bridge.setApiKey(entry.provider, key);
    entry.hasKey = true;
    entry.masked = '•'.repeat(24);
    entry.key = '';
    entry.editing = false;
  } catch (error) {
    console.error('Failed to save API key:', error);
  }
}

async function removeKey(entry: KeyEntry): Promise<void> {
  try {
    await bridge.setApiKey(entry.provider, '');
    entry.hasKey = false;
    entry.masked = '';
    entry.key = '';
    entry.editing = false;
  } catch (error) {
    console.error('Failed to remove API key:', error);
  }
}

function getDisplayName(providerId: string): string {
  return commonProviders.find((p) => p.id === providerId)?.name || providerId;
}

async function addCustomKey(): Promise<void> {
  const provider = customProvider.value.trim();
  const key = customKey.value.trim();
  if (!provider || !key) return;

  try {
    await bridge.setApiKey(provider, key);
    keyEntries.value.push({
      provider,
      key: '',
      masked: '•'.repeat(24),
      hasKey: true,
      editing: false,
    });
    customProvider.value = '';
    customKey.value = '';
  } catch (error) {
    console.error('Failed to add custom key:', error);
  }
}
</script>

<template>
  <div class="api-key-form">
    <div class="form-header">
      <h4>API 密钥</h4>
      <p class="form-desc">
        API 密钥仅存储在本地，只发送给对应 AI 提供商的 API。
        不会与第三方共享。
      </p>
    </div>

    <div class="key-list">
      <div
        v-for="entry in keyEntries"
        :key="entry.provider"
        class="key-item"
        :class="{ editing: entry.editing }"
      >
        <div class="key-info">
          <span class="key-provider-name">{{ getDisplayName(entry.provider) }}</span>
          <span class="key-provider-id">{{ entry.provider }}</span>
        </div>

        <div class="key-actions">
          <!-- Has key, not editing -->
          <template v-if="entry.hasKey && !entry.editing">
            <span class="key-status configured">✓ 已配置</span>
            <button class="key-btn edit" @click="startEdit(entry)">修改</button>
            <button class="key-btn remove" @click="removeKey(entry)">✕</button>
          </template>

          <!-- No key, not editing -->
          <template v-else-if="!entry.hasKey && !entry.editing">
            <span class="key-status missing">未设置</span>
            <button class="key-btn add" @click="startEdit(entry)">+ 添加</button>
          </template>

          <!-- Editing -->
          <template v-else>
            <input
              v-model="entry.key"
              class="key-input"
              type="password"
              placeholder="输入 API 密钥..."
              @keyup.enter="saveKey(entry)"
              @keyup.escape="cancelEdit(entry)"
              autofocus
            />
            <button class="key-btn save" @click="saveKey(entry)">保存</button>
            <button class="key-btn cancel" @click="cancelEdit(entry)">取消</button>
          </template>
        </div>
      </div>
    </div>

    <!-- Custom provider -->
    <div class="add-custom">
      <details>
        <summary class="custom-summary">+ 添加自定义提供商</summary>
        <div class="custom-form">
          <input
            v-model="customProvider"
            class="custom-provider-input"
            placeholder="Provider ID (e.g., custom-api)"
          />
          <input
            v-model="customKey"
            class="custom-key-input"
            type="password"
            placeholder="API Key"
          />
          <button class="key-btn save" @click="addCustomKey">Add</button>
        </div>
      </details>
    </div>
  </div>
</template>

<style scoped>
.api-key-form {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.form-header {
  margin-bottom: 12px;
}

.form-header h4 {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 4px;
}

.form-desc {
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.4;
}

.key-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.key-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  background: var(--color-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  gap: 8px;
  transition: border-color 0.15s;
}

.key-item.editing {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 5%, var(--color-surface));
}

.key-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}

.key-provider-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
}

.key-provider-id {
  font-size: 10px;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
}

.key-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.key-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 8px;
}

.key-status.configured {
  color: var(--color-green);
  background: color-mix(in srgb, var(--color-green) 15%, transparent);
}

.key-status.missing {
  color: var(--color-text-muted);
}

.key-btn {
  font-size: 11px;
  padding: 3px 10px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  transition: all 0.12s;
}

.key-btn:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.key-btn.save {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-bg);
}

.key-btn.save:hover {
  opacity: 0.9;
}

.key-btn.remove {
  color: var(--color-red);
  border-color: transparent;
  background: transparent;
  padding: 3px 6px;
}

.key-btn.remove:hover {
  background: color-mix(in srgb, var(--color-red) 15%, transparent);
}

.key-btn.add {
  color: var(--color-accent);
  border-color: var(--color-accent);
}

.key-input {
  width: 180px;
  padding: 4px 8px;
  font-size: 12px;
  font-family: var(--font-mono);
  border-radius: 3px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--border-color);
  color: var(--color-text);
  outline: none;
}

.key-input:focus {
  border-color: var(--color-accent);
}

.add-custom {
  margin-top: 8px;
}

.custom-summary {
  font-size: 12px;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 4px 0;
  user-select: none;
}

.custom-summary:hover {
  color: var(--color-accent);
}

.custom-form {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.custom-provider-input,
.custom-key-input {
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 3px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--border-color);
  color: var(--color-text);
  outline: none;
}

.custom-provider-input {
  width: 120px;
}

.custom-key-input {
  flex: 1;
}

.custom-provider-input:focus,
.custom-key-input:focus {
  border-color: var(--color-accent);
}
</style>
