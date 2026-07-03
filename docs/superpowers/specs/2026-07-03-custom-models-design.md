# 自定义端点 / 模型 设计

日期：2026-07-03
状态：已确认设计，待编写实现计划

## 目标

让用户能接入任意 OpenAI 兼容 / Anthropic 兼容的自建或第三方端点，补齐"模型名字 / 模型列表 / URL / Key / API 格式"五项参数。当前项目只支持内置 provider（key），无法接自定义 base URL，自定义模型 id 也无法被 pi-ai 的 `getModel` 解析。

## 形态决策（已对齐）

- **录入粒度**：一个自定义 endpoint（URL + Key + API 格式）下挂多个模型 id，与现有「provider → models」两层结构一致。
- **API 格式选项**：`openai-completions`、`openai-responses`、`anthropic-messages` 三选一。
- **每条模型字段**：`模型 id`（必填）+ `显示名`（可选，留空用 id）+ `上下文窗口`（可选，默认 128000）。
- **系统 provider id**：由显示名 slugify 生成（`custom-<slug>`），用户无感，冲突自动追加 `-2`/`-3`。
- **UI**：新建独立设置区块「自定义端点」，删除 `ApiKeyForm.vue` 旧的那个只填 provider id + key 的折叠入口。
- **存储范围**：仅全局（`~/.suncode/config.json`），不做项目级合并。

## §1 数据模型

`src/shared/types.ts` 新增：

```ts
export type CustomApiFormat = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

export interface CustomModelEntry {
  id: string;             // 必填，模型 id，发送给端点
  name?: string;          // 可选显示名，留空则用 id
  contextWindow?: number; // 可选，默认 128000
}

export interface CustomEndpoint {
  id: string;             // 系统 provider id，由显示名 slugify 生成，确保唯一
  name: string;           // 显示名
  baseUrl: string;        // 必填
  apiKey: string;         // 必填，与 envApiKeys 体系分离，独立存这里
  apiFormat: CustomApiFormat;
  models: CustomModelEntry[];
}
```

`AppSettings` 新增 `customEndpoints: CustomEndpoint[]`，`DEFAULT_SETTINGS`（`src/shared/constants.ts`）默认 `[]`。

- 自定义 endpoint 的 `apiKey` 直接存在 `CustomEndpoint.apiKey`，**不复用 `envApiKeys`**。`envApiKeys` 继续只管内置 provider。
- slug 生成：`'custom-' + slugify(name)`，与内置 provider 或已有自定义 endpoint id 冲突时追加 `-2`、`-3`。
- `loadSettings` 仍会做全局/项目级 merge，但 UI 只写全局 scope（`saveSettings(scope: 'global')`）。

## §2 运行时模型构造（registry 短路）

`src/worker/models/registry.ts`：

```ts
export function createModelRegistry(customEndpoints: CustomEndpoint[] = []) { ... }
```

`getModel(provider, modelId)` 在调 pi-ai 之前加短路：

1. 在 `customEndpoints` 中找 `endpoint.id === provider`；
2. 命中后在该 endpoint 的 `models` 中找 `m.id === modelId`；
3. 命中则手动构造 pi-ai `Model` 对象返回：
   ```ts
   {
     id,
     name: entry.name || entry.id,
     api: endpoint.apiFormat,
     provider: endpoint.id,
     baseUrl: endpoint.baseUrl,
     reasoning: false,
     input: ['text'],
     cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
     contextWindow: entry.contextWindow || 128000,
     maxTokens: 4096,
     headers: <按 apiFormat 构造鉴权 header>
   }
   ```
4. 不命中再走原 pi-ai `getModel`。

**鉴权 header 差异**集中在 registry 构造处：
- `openai-completions` / `openai-responses`：`{ Authorization: \`Bearer ${apiKey}\` }`
- `anthropic-messages`：`{ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }`

`getRecommendedModels()` / `getModels()` 不动。自定义模型不进"推荐"，也不假装能列出内置 provider 的模型。

**调用方改动**仅一处：`src/worker/agent/agent.ts` 两处 `createModelRegistry()` 改为 `createModelRegistry(this.settings.customEndpoints ?? [])`。agent 层无其他感知。

## §3 UI 与交互

**新增组件** `src/renderer/components/settings/CustomEndpoints.vue`，作为设置页独立区块「自定义端点」。

**列表态**：已配置 endpoint 卡片，显示：显示名、URL（截断）、API 格式 tag、模型数量、编辑 / 删除按钮。

**编辑态（单张表单）**：
- 显示名（input）
- URL（input）
- API Key（password input）
- API 格式（三选一 select）
- 模型列表：动态可增删的行，每行 = `模型 id` + `显示名(可选)` + `上下文窗口(可选, 数字)` + 删除按钮；底部"+ 添加模型"按钮。
- 保存 / 取消

**保存校验**：显示名、URL、API Key 非空；至少 1 个模型 id 非空；URL 简单格式校验。失败就地报错，不关闭表单。保存时生成/保持唯一 `id`。

**存储**：`settingsStore.update({ customEndpoints: [...] })`，写全局 scope。

**接入 ModelSelector**（在 `src/renderer/stores/models.ts` 适配，ModelSelector.vue 基本不动）：
- `initAll` 时把 `customEndpoints` 注入：
  - `providers` 追加自定义 endpoint 的 id；
  - `providerModels` Map 为每个自定义 endpoint 塞入其 `models`（label 用 `name||id` + `(contextWindow/1000)k`）；
  - `recommendedModels` 不动；
  - `hasKey` 对自定义 endpoint 恒为 `true`（key 存在 endpoint 内，保存时已校验）。
- 自定义 provider 变更后需要刷新 store（重新注入），具体由 `CustomEndpoints.vue` 保存成功后触发 `modelsStore` 的刷新方法。

`ModelSelector.vue` 的「全部模型」tab 会自动出现自定义 provider chip 和其模型，选中即 `selectModel(endpoint.id, model.id)`，写入 `activeProvider/activeModel`，跑推理时 registry 短路命中。

**删除旧入口**：`ApiKeyForm.vue` 底部"+ 添加自定义提供商"折叠区（`customProvider` / `customKey` / `addCustomKey` 相关 `<template>` 与 `<script>`）整段移除。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | 新增 `CustomApiFormat` / `CustomModelEntry` / `CustomEndpoint`；`AppSettings` 加 `customEndpoints` |
| `src/shared/constants.ts` | `DEFAULT_SETTINGS.customEndpoints = []` |
| `src/worker/models/registry.ts` | `createModelRegistry(customEndpoints)`，`getModel` 短路构造自定义 `Model` |
| `src/worker/agent/agent.ts` | 两处 `createModelRegistry()` 传 `this.settings.customEndpoints` |
| `src/renderer/components/settings/CustomEndpoints.vue` | 新建：endpoint 列表 + 编辑表单 |
| `src/renderer/components/settings/SettingsPanel.vue` | 在 `models` section（`activeSection === 'models'`）内 `<ModelSelector />` 下方挂载 `<CustomEndpoints />` |
| `src/renderer/stores/models.ts` | `initAll` 注入 `customEndpoints` 到 providers / providerModels；提供刷新方法 |

## 不在本次范围

- 自定义模型的 `maxTokens` / `支持推理` / `支持图片` 等高级字段（§3 决策为极简档 B）。
- 项目级自定义端点覆盖。
- 内置 provider 的 baseUrl 覆盖。
- 自定义端点的连通性测试按钮（可后续加）。