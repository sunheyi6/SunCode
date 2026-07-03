# 自定义端点 / 模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在设置里配置任意 OpenAI 兼容 / Anthropic 兼容端点（URL + Key + API 格式 + 多个模型 id），并在模型选择器中选用，运行时由 registry 短路构造 pi-ai `Model` 对象。

**Architecture:** `AppSettings.customEndpoints` 存全局；`createModelRegistry(customEndpoints)` 的 `getModel` 在调 pi-ai 前先匹配自定义 endpoint，命中则用 `buildCustomModel` 手动构造 `Model`；renderer `models` store 把自定义 endpoint 注入 providers / providerModels，`ModelSelector` 无感复用；新建 `CustomEndpoints.vue` 设置组件。

**Tech Stack:** TypeScript + Vue 3 + Pinia + pi-ai (`@earendil-works/pi-ai`) + Vitest。

测试约定：本项目无 Vue 组件测试基建（`environment: 'node'`，无 `@vue/test-utils`），因此把可测纯逻辑抽到 `.ts` 文件单测，`.vue` 组件只做胶水（靠 `bun run typecheck` + 手动验证）。

---

### Task 1: 数据模型 — 类型与默认值

**Files:**
- Modify: `src/shared/types.ts`（在 `AppSettings` 接口上方新增类型，`AppSettings` 加字段）
- Modify: `src/shared/constants.ts`（`DEFAULT_SETTINGS` 加 `customEndpoints`）
- Create: `test/shared/settings-types.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/shared/settings-types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { AppSettings, CustomApiFormat, CustomEndpoint, CustomModelEntry } from '@shared/types';

describe('customEndpoints data model', () => {
  it('DEFAULT_SETTINGS.customEndpoints 初始化为空数组', () => {
    expect(DEFAULT_SETTINGS.customEndpoints).toEqual([]);
  });

  it('DEFAULT_SETTINGS 满足 AppSettings 形状', () => {
    const s: AppSettings = { ...DEFAULT_SETTINGS } as AppSettings;
    expect(Array.isArray(s.customEndpoints)).toBe(true);
  });

  it('CustomEndpoint / CustomModelEntry 字段齐备', () => {
    const m: CustomModelEntry = { id: 'gpt-x', name: 'GPT X', contextWindow: 64000 };
    const e: CustomEndpoint = {
      id: 'custom-my-gw',
      name: '我的网关',
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sk-xxx',
      apiFormat: 'openai-completions',
      models: [m, { id: 'qwen-x' }],
    };
    expect(e.models).toHaveLength(2);
    expect(e.apiFormat satisfies CustomApiFormat).toBe('openai-completions');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run test -- test/shared/settings-types.test.ts"`
Expected: FAIL —— `Property 'customEndpoints' does not exist on type 'DEFAULT_SETTINGS'` 或类型导入报错。

- [ ] **Step 3: 在 `src/shared/types.ts` 增加类型**

在 `export interface AppSettings {` 之前插入：

```ts
/** 自定义端点的 API 协议格式，与 pi-ai 的 KnownApi 对齐。 */
export type CustomApiFormat = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

/** 自定义端点下的单个模型条目。 */
export interface CustomModelEntry {
  /** 必填，模型 id，发送给端点。 */
  id: string;
  /** 可选显示名，留空则用 id。 */
  name?: string;
  /** 可选上下文窗口（token），默认 128000。 */
  contextWindow?: number;
}

/** 自定义端点（一个 URL + Key + API 格式下挂多个模型）。 */
export interface CustomEndpoint {
  /** 系统 provider id，由显示名 slugify 生成，确保唯一。 */
  id: string;
  /** 显示名。 */
  name: string;
  /** Base URL。 */
  baseUrl: string;
  /** API Key（独立存储，不复用 envApiKeys）。 */
  apiKey: string;
  apiFormat: CustomApiFormat;
  models: CustomModelEntry[];
}
```

在 `AppSettings` 接口内（`envApiKeys` 行下方）加：

```ts
  /** 自定义端点列表（仅全局存储）。 */
  customEndpoints: CustomEndpoint[];
```

- [ ] **Step 4: 在 `src/shared/constants.ts` 的 `DEFAULT_SETTINGS` 加默认值**

在 `DEFAULT_SETTINGS` 对象内 `envApiKeys: {},` 行下方加：

```ts
  customEndpoints: [],
```

- [ ] **Step 5: 运行测试确认通过**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run test -- test/shared/settings-types.test.ts"`
Expected: PASS（3 个用例）。

- [ ] **Step 6: typecheck + lint**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run typecheck"`
Expected: 零错误。

- [ ] **Step 7: 提交**

```bash
"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && git add src/shared/types.ts src/shared/constants.ts test/shared/settings-types.test.ts && git commit -m 'feat(settings): 新增 customEndpoints 数据模型'"
```

---

### Task 2: Registry 短路 — 构造自定义 Model

**Files:**
- Modify: `src/worker/models/registry.ts`
- Create: `test/worker/models-registry.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/worker/models-registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CustomEndpoint } from '@shared/types';
import { buildCustomModel, createModelRegistry } from '../../src/worker/models/registry';

function endpoint(over: Partial<CustomEndpoint>): CustomEndpoint {
  return {
    id: 'custom-gw',
    name: '网关',
    baseUrl: 'https://gw.example.com/v1',
    apiKey: 'sk-test',
    apiFormat: 'openai-completions',
    models: [{ id: 'm1' }, { id: 'm2', name: 'M2', contextWindow: 64000 }],
    ...over,
  };
}

describe('buildCustomModel', () => {
  it('用默认值填充 name / contextWindow', () => {
    const m = buildCustomModel(endpoint({}), { id: 'm1' });
    expect(m.id).toBe('m1');
    expect(m.name).toBe('m1');
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBe(4096);
    expect(m.reasoning).toBe(false);
    expect(m.input).toEqual(['text']);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('openai-completions 使用 Bearer 鉴权', () => {
    const m = buildCustomModel(endpoint({}), { id: 'm1' });
    expect(m.api).toBe('openai-completions');
    expect(m.headers).toEqual({ Authorization: 'Bearer sk-test' });
  });

  it('openai-responses 使用 Bearer 鉴权', () => {
    const m = buildCustomModel(endpoint({ apiFormat: 'openai-responses' }), { id: 'm1' });
    expect(m.api).toBe('openai-responses');
    expect(m.headers.Authorization).toBe('Bearer sk-test');
  });

  it('anthropic-messages 使用 x-api-key + version', () => {
    const m = buildCustomModel(endpoint({ apiFormat: 'anthropic-messages' }), { id: 'm1' });
    expect(m.api).toBe('anthropic-messages');
    expect(m.headers).toEqual({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' });
  });

  it('沿用 entry 的 name / contextWindow', () => {
    const m = buildCustomModel(endpoint({}), { id: 'm2', name: 'M2', contextWindow: 64000 });
    expect(m.name).toBe('M2');
    expect(m.contextWindow).toBe(64000);
    expect(m.provider).toBe('custom-gw');
    expect(m.baseUrl).toBe('https://gw.example.com/v1');
  });
});

describe('createModelRegistry.getModel 自定义短路', () => {
  it('命中自定义 endpoint + 模型时返回构造对象', async () => {
    const reg = createModelRegistry([endpoint({})]);
    const m = await reg.getModel('custom-gw', 'm1');
    expect(m).not.toBeNull();
    expect((m as { id: string }).id).toBe('m1');
  });

  it('endpoint 存在但模型未列出时返回 null', async () => {
    const reg = createModelRegistry([endpoint({})]);
    const m = await reg.getModel('custom-gw', 'no-such-model');
    expect(m).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run test -- test/worker/models-registry.test.ts"`
Expected: FAIL —— `buildCustomModel / createModelRegistry 导出不存在` 或短路未命中（pi-ai 报错）。

- [ ] **Step 3: 改 `src/worker/models/registry.ts`**

在文件顶部 import 区追加：

```ts
import type { CustomEndpoint, CustomModelEntry } from '@shared/types';
```

在 `export interface ModelInfo { ... }` 之后新增导出：

```ts
/** 由自定义 endpoint + 模型条目构造的 pi-ai Model 兼容对象。 */
export interface CustomModelSpec {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers: Record<string, string>;
}

/** 纯函数：根据 endpoint 与模型条目构造 Model 兼容对象（含鉴权 header）。 */
export function buildCustomModel(
  endpoint: CustomEndpoint,
  entry: CustomModelEntry,
): CustomModelSpec {
  const headers: Record<string, string> =
    endpoint.apiFormat === 'anthropic-messages'
      ? { 'x-api-key': endpoint.apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${endpoint.apiKey}` };
  return {
    id: entry.id,
    name: entry.name || entry.id,
    api: endpoint.apiFormat,
    provider: endpoint.id,
    baseUrl: endpoint.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow || 128000,
    maxTokens: 4096,
    headers,
  };
}
```

把 `export function createModelRegistry() {` 改为接收参数：

```ts
export function createModelRegistry(customEndpoints: CustomEndpoint[] = []) {
```

把 `getModel` 方法体改为（在原 `try { const { getModel } = await import(...) ... }` 之前短路）：

```ts
    async getModel(provider: string, modelId: string): Promise<unknown> {
      const ep = customEndpoints.find((e) => e.id === provider);
      if (ep) {
        const entry = ep.models.find((m) => m.id === modelId);
        return entry ? buildCustomModel(ep, entry) : null;
      }
      try {
        const { getModel } = await import('@earendil-works/pi-ai');
        return getModel(provider as any, modelId);
      } catch {
        console.warn(
          '@earendil-works/pi-ai not available. Install it for multi-provider model support.',
        );
        return null;
      }
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run test -- test/worker/models-registry.test.ts"`
Expected: PASS（7 个用例）。

- [ ] **Step 5: typecheck**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run typecheck"`
Expected: 零错误。

- [ ] **Step 6: 提交**

```bash
"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && git add src/worker/models/registry.ts test/worker/models-registry.test.ts && git commit -m 'feat(models): registry 短路构造自定义端点 Model'"
```

---

### Task 3: Agent 接线 — 传入 customEndpoints

**Files:**
- Modify: `src/worker/agent/agent.ts`（两处 `createModelRegistry()` 调用）

- [ ] **Step 1: 修改 `runLoop` 内的调用**

`src/worker/agent/agent.ts` 中 `private async runLoop(runId: string, summaryMode = false): Promise<void> {` 方法内（约 440 行）：

把
```ts
    const modelRegistry = createModelRegistry();
    const model = await modelRegistry.getModel(
      this.settings.activeProvider,
      this.settings.activeModel,
    );
```
改为
```ts
    const modelRegistry = createModelRegistry(this.settings.customEndpoints ?? []);
    const model = await modelRegistry.getModel(
      this.settings.activeProvider,
      this.settings.activeModel,
    );
```

- [ ] **Step 2: 修改 `runGoalLoop` 内的调用**

同文件 `private async runGoalLoop(runId: string, goalDef: ...): Promise<void> {` 方法内（约 611 行）：

把
```ts
    const modelRegistry = createModelRegistry();
    const model = await modelRegistry.getModel(
      this.settings.activeProvider,
      this.settings.activeModel,
    );
```
改为
```ts
    const modelRegistry = createModelRegistry(this.settings.customEndpoints ?? []);
    const model = await modelRegistry.getModel(
      this.settings.activeProvider,
      this.settings.activeModel,
    );
```

- [ ] **Step 3: typecheck**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run typecheck"`
Expected: 零错误。

- [ ] **Step 4: 提交**

```bash
"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && git add src/worker/agent/agent.ts && git commit -m 'feat(agent): 向 registry 传入 customEndpoints'"
```

---

### Task 4: Models Store — 注入自定义端点

**Files:**
- Create: `src/renderer/stores/custom-endpoints-helpers.ts`
- Create: `test/renderer/custom-endpoints-helpers.test.ts`
- Modify: `src/renderer/stores/models.ts`

- [ ] **Step 1: 写失败测试**

Create `test/renderer/custom-endpoints-helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CustomEndpoint } from '@shared/types';
import {
  buildCustomModelOptions,
  computeCustomEndpointState,
} from '../../src/renderer/stores/custom-endpoints-helpers';

function ep(over: Partial<CustomEndpoint>): CustomEndpoint {
  return {
    id: 'custom-gw',
    name: '网关',
    baseUrl: 'https://gw/v1',
    apiKey: 'k',
    apiFormat: 'openai-completions',
    models: [{ id: 'm1' }, { id: 'm2', name: 'M2', contextWindow: 64000 }],
    ...over,
  };
}

describe('buildCustomModelOptions', () => {
  it('为 endpoint 下每个模型生成 ModelOption', () => {
    const opts = buildCustomModelOptions(ep({}));
    expect(opts).toEqual([
      { provider: 'custom-gw', model: 'm1', label: 'm1 (128k)' },
      { provider: 'custom-gw', model: 'm2', label: 'M2 (64k)' },
    ]);
  });

  it('空模型列表返回空数组', () => {
    expect(buildCustomModelOptions(ep({ models: [] }))).toEqual([]);
  });
});

describe('computeCustomEndpointState', () => {
  it('聚合多个 endpoint 的 providers / providerModels / keyStatus', () => {
    const state = computeCustomEndpointState([
      ep({ id: 'custom-a', models: [{ id: 'x' }] }),
      ep({ id: 'custom-b', models: [{ id: 'y' }, { id: 'z' }] }),
    ]);
    expect(state.providerIds).toEqual(['custom-a', 'custom-b']);
    expect(state.providerModels.get('custom-a')).toEqual([
      { provider: 'custom-a', model: 'x', label: 'x (128k)' },
    ]);
    expect(state.providerModels.get('custom-b')).toHaveLength(2);
    expect(state.keyStatus).toEqual({ 'custom-a': true, 'custom-b': true });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run test -- test/renderer/custom-endpoints-helpers.test.ts"`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 创建 `src/renderer/stores/custom-endpoints-helpers.ts`**

```ts
import type { CustomEndpoint } from '@shared/types';
import type { ModelOption } from './models';

/** 为单个自定义 endpoint 下每个模型生成 ModelOption。 */
export function buildCustomModelOptions(endpoint: CustomEndpoint): ModelOption[] {
  return endpoint.models.map((m) => {
    const ctx = m.contextWindow || 128000;
    return {
      provider: endpoint.id,
      model: m.id,
      label: `${m.name || m.id} (${(ctx / 1000).toFixed(0)}k)`,
    };
  });
}

export interface CustomEndpointState {
  providerIds: string[];
  providerModels: Map<string, ModelOption[]>;
  keyStatus: Record<string, boolean>;
}

/** 聚合多个自定义 endpoint 为 store 注入所需的状态。 */
export function computeCustomEndpointState(endpoints: CustomEndpoint[]): CustomEndpointState {
  const providerModels = new Map<string, ModelOption[]>();
  const keyStatus: Record<string, boolean> = {};
  for (const ep of endpoints) {
    providerModels.set(ep.id, buildCustomModelOptions(ep));
    keyStatus[ep.id] = true;
  }
  return {
    providerIds: endpoints.map((e) => e.id),
    providerModels,
    keyStatus,
  };
}
```

注意：`ModelOption` 在 `models.ts` 里目前是 `export interface ModelOption`。本任务 Step 4 会确保它仍被导出（已导出，无需改）。

- [ ] **Step 4: 运行测试确认通过**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run test -- test/renderer/custom-endpoints-helpers.test.ts"`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 改 `src/renderer/stores/models.ts` 注入逻辑**

在文件顶部 import 区追加：

```ts
import type { CustomEndpoint } from '@shared/types';
import { computeCustomEndpointState } from './custom-endpoints-helpers';
```

把 `const BUILTIN_PROVIDERS = [` 改为 `export const BUILTIN_PROVIDERS = [`（导出，供组件生成 id 时避让内置 provider）。

在 store 工厂内（`const keyStatus = ref<Record<string, boolean>>({});` 下方）新增一个 builtin 集合常量与同步函数：

```ts
  const builtinProviderSet = new Set(BUILTIN_PROVIDERS);

  /** 把自定义 endpoint 注入 providers / providerModels / keyStatus，并清理旧的自定义条目。 */
  function syncCustomEndpoints(endpoints: CustomEndpoint[]): void {
    const state = computeCustomEndpointState(endpoints);

    // providers = 内置 + 自定义（去重）
    const customIds = state.providerIds.filter((id) => !builtinProviderSet.has(id));
    providers.value = [...BUILTIN_PROVIDERS, ...customIds];

    // 清理旧的自定义 providerModels，再写入新的
    for (const id of [...providerModels.value.keys()]) {
      if (!builtinProviderSet.has(id)) providerModels.value.delete(id);
    }
    for (const [id, opts] of state.providerModels) providerModels.value.set(id, opts);

    // 清理旧的自定义 keyStatus，再写入新的
    const nextKeyStatus: Record<string, boolean> = {};
    for (const [id, has] of Object.entries(keyStatus.value)) {
      if (builtinProviderSet.has(id)) nextKeyStatus[id] = has;
    }
    for (const [id, has] of Object.entries(state.keyStatus)) nextKeyStatus[id] = has;
    keyStatus.value = nextKeyStatus;
  }
```

在 `initAll` 内，把对 settings 的读取补上 `customEndpoints` 注入。把这段：

```ts
    if (initialSettings) {
      activeProvider.value = initialSettings.activeProvider;
      activeModel.value = initialSettings.activeModel;
    } else {
      try {
        const s = await bridge.getSettings();
        if (s.activeProvider) activeProvider.value = s.activeProvider;
        if (s.activeModel) activeModel.value = s.activeModel;
      } catch {
        /* use defaults */
      }
    }
```

改为：

```ts
    if (initialSettings) {
      activeProvider.value = initialSettings.activeProvider;
      activeModel.value = initialSettings.activeModel;
      syncCustomEndpoints(initialSettings.customEndpoints ?? []);
    } else {
      try {
        const s = await bridge.getSettings();
        if (s.activeProvider) activeProvider.value = s.activeProvider;
        if (s.activeModel) activeModel.value = s.activeModel;
        syncCustomEndpoints(s.customEndpoints ?? []);
      } catch {
        /* use defaults */
      }
    }
```

在 `return { ... }` 的导出对象里追加：

```ts
    syncCustomEndpoints,
```

- [ ] **Step 6: typecheck + 全量测试**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run typecheck && bun run test"`
Expected: typecheck 零错误；所有测试 PASS（含新增 4 个）。

- [ ] **Step 7: 提交**

```bash
"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && git add src/renderer/stores/custom-endpoints-helpers.ts src/renderer/stores/models.ts test/renderer/custom-endpoints-helpers.test.ts && git commit -m 'feat(models-store): 注入自定义端点到 providers/providerModels'"
```

---

### Task 5: 自定义端点纯逻辑 — id 生成与校验

**Files:**
- Create: `src/renderer/components/settings/custom-endpoints.ts`
- Create: `test/renderer/custom-endpoints.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/renderer/custom-endpoints.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generateEndpointId, validateEndpoint } from '../../src/renderer/components/settings/custom-endpoints';

describe('generateEndpointId', () => {
  it('中文会被替换为分隔符，slug 为空时兜底 endpoint', () => {
    expect(generateEndpointId('我的内网网关', [], [])).toBe('custom-endpoint');
  });

  it('符号压缩为连字符并修剪首尾', () => {
    expect(generateEndpointId('---My  GW---', [], [])).toBe('custom-my-gw');
  });

  it('英文/数字正常 slugify', () => {
    expect(generateEndpointId('My Gateway 2', [], [])).toBe('custom-my-gateway-2');
  });

  it('与已有 id 冲突时追加 -2/-3', () => {
    expect(generateEndpointId('My Gateway', ['custom-my-gateway'], [])).toBe('custom-my-gateway-2');
    expect(
      generateEndpointId('My Gateway', ['custom-my-gateway', 'custom-my-gateway-2'], []),
    ).toBe('custom-my-gateway-3');
  });

  it('与内置 provider 冲突时也避让', () => {
    expect(generateEndpointId('openai', [], ['openai'])).toBe('custom-openai-2');
  });
});

describe('validateEndpoint', () => {
  const ok = {
    name: 'GW',
    baseUrl: 'https://gw/v1',
    apiKey: 'k',
    models: [{ id: 'm1' }],
  };

  it('合法表单返回空数组', () => {
    expect(validateEndpoint(ok)).toEqual([]);
  });

  it('缺显示名', () => {
    expect(validateEndpoint({ ...ok, name: ' ' })).toContain('显示名不能为空');
  });

  it('URL 非法', () => {
    expect(validateEndpoint({ ...ok, baseUrl: 'gw' })).toContain('URL 需以 http:// 或 https:// 开头');
    expect(validateEndpoint({ ...ok, baseUrl: '' })).toContain('URL 不能为空');
  });

  it('缺 Key', () => {
    expect(validateEndpoint({ ...ok, apiKey: '' })).toContain('API Key 不能为空');
  });

  it('无有效模型', () => {
    expect(validateEndpoint({ ...ok, models: [{ id: '' }] })).toContain('至少添加一个模型');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run test -- test/renderer/custom-endpoints.test.ts"`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 创建 `src/renderer/components/settings/custom-endpoints.ts`**

```ts
/** 自定义端点表单（编辑态）的形状。 */
export interface EndpointForm {
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  models: { id: string; name: string; contextWindow: string }[];
}

/** 由显示名生成唯一 provider id：custom-<slug>，冲突追加 -2/-3。 */
export function generateEndpointId(
  name: string,
  existingIds: string[],
  builtinIds: string[],
): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = `custom-${slug || 'endpoint'}`;
  const taken = new Set([...existingIds, ...builtinIds]);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** 校验表单，返回错误消息列表（空表示合法）。 */
export function validateEndpoint(form: {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: { id: string }[];
}): string[] {
  const errs: string[] = [];
  if (!form.name.trim()) errs.push('显示名不能为空');
  if (!form.baseUrl.trim()) errs.push('URL 不能为空');
  else if (!/^https?:\/\//i.test(form.baseUrl.trim()))
    errs.push('URL 需以 http:// 或 https:// 开头');
  if (!form.apiKey.trim()) errs.push('API Key 不能为空');
  const validModels = form.models.filter((m) => m.id.trim());
  if (validModels.length === 0) errs.push('至少添加一个模型');
  return errs;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run test -- test/renderer/custom-endpoints.test.ts"`
Expected: PASS（10 个用例）。

- [ ] **Step 5: 提交**

```bash
"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && git add src/renderer/components/settings/custom-endpoints.ts test/renderer/custom-endpoints.test.ts && git commit -m 'feat(settings): 自定义端点 id 生成与表单校验纯逻辑'"
```

---

### Task 6: CustomEndpoints.vue 组件 + 挂载

**Files:**
- Create: `src/renderer/components/settings/CustomEndpoints.vue`
- Modify: `src/renderer/components/settings/SettingsPanel.vue`（import + 在 models section 挂载）

- [ ] **Step 1: 创建 `src/renderer/components/settings/CustomEndpoints.vue`**

```vue
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CustomApiFormat, CustomEndpoint } from '@shared/types';
import { useSettingsStore } from '../../stores/settings';
import { BUILTIN_PROVIDERS, useModelsStore } from '../../stores/models';
import { generateEndpointId, validateEndpoint, type EndpointForm } from './custom-endpoints';

const settingsStore = useSettingsStore();
const modelsStore = useModelsStore();

const endpoints = computed<CustomEndpoint[]>(
  () => settingsStore.settings.customEndpoints ?? [],
);

// 编辑态
const editingIndex = ref<number | null>(null); // null = 列表态；-1 = 新建
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
  if (form.value.models.length === 0) form.value.models.push({ id: '', name: '', contextWindow: '' });
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
```

- [ ] **Step 2: 改 `src/renderer/components/settings/SettingsPanel.vue` 挂载**

在 `<script setup lang="ts">` 的 import 区，`import ModelSelector from './ModelSelector.vue';` 下方加：

```ts
import CustomEndpoints from './CustomEndpoints.vue';
```

把 models section：

```vue
          <section v-else-if="activeSection === 'models'" class="settings-stack">
            <ModelSelector />
          </section>
```

改为：

```vue
          <section v-else-if="activeSection === 'models'" class="settings-stack">
            <ModelSelector />
            <CustomEndpoints />
          </section>
```

- [ ] **Step 3: typecheck + lint**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run typecheck && bun run lint"`
Expected: typecheck 零错误；lint 无新增 error（warning 可接受）。

Vue SFC 模板引用变量若被 biome 误报 unused，按项目约定加抑制注释：
`// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.`（仅在报错时加）。

- [ ] **Step 4: 全量测试**

Run: `"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run test"`
Expected: 全部 PASS（无回归）。

- [ ] **Step 5: 手动验证**

启动开发服务器：`"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && bun run dev"`（后台运行，窗口弹出即成功，不要二次读日志）。

在设置 → 模型设置 页面：
1. 「自定义端点」区块出现，点「+ 添加端点」。
2. 填：显示名 `Test GW`、URL `http://localhost:11434/v1`、Key `dummy`、API 格式选 OpenAI Completions、模型列表加一个 id `qwen-test`。保存。
3. 区块出现卡片；切到模型选择器「全部模型」tab，能看到 `Test GW` provider chip 和 `qwen-test (128k)` 模型。
4. 选中该模型 → 当前模型显示为它。
5. 编辑该端点改名 / 加第二个模型 → 保存后模型列表刷新。
6. 删除端点 → 选择器中对应 provider 消失。

- [ ] **Step 6: 提交**

```bash
"D:\soft\Git\bin\bash.exe" -c "cd /d/project/SunCode && git add src/renderer/components/settings/CustomEndpoints.vue src/renderer/components/settings/SettingsPanel.vue && git commit -m 'feat(settings): 自定义端点配置 UI 与挂载'"
```

---

## 完成标准

- `bun run typecheck` 零错误。
- `bun run lint` 无新增 error。
- `bun run test` 全部 PASS（新增测试文件：`test/shared/settings-types.test.ts`、`test/worker/models-registry.test.ts`、`test/renderer/custom-endpoints-helpers.test.ts`、`test/renderer/custom-endpoints.test.ts`）。
- 设置页可增删改自定义端点；模型选择器可见并可选自定义模型；选中后能触发推理（端点真实可达时）。

## 不在本次范围

- 自定义模型的 maxTokens / reasoning / image 高级字段。
- 项目级自定义端点覆盖。
- 内置 provider 的 baseUrl 覆盖。
- 自定义端点连通性测试按钮。