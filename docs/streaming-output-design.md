# 流式输出渲染设计

## 1. 设计目标

聊天界面的流式输出要让用户**一眼看清整体运行逻辑**，而不是被每一轮大模型的中间叙述淹没。核心诉求：

- 时间轴读作 `模型输出 → 工具执行 → 模型输出 → 工具执行 → … → 最终输出`
- 中间轮的大模型文本默认折叠成一行预览，需要细节时再展开
- 模型的纯思考/推理文字可由设置开关控制是否展示；工具与命令执行轨迹始终保留
- UI 只为呈现运行逻辑，不做意图识别、不替模型做决策

---

## 2. 数据模型

### 2.1 ChatMessageBlock — 块序列

`useChatStore`（`src/renderer/stores/chat.ts`）为每个 assistant 消息维护一个有序的 `blocks` 数组，按 delta 到达时间顺序追加：

```typescript
interface ChatMessageBlock {
  id: string;
  type: 'thinking' | 'text' | 'tool_call';
  thinking?: string;   // type === 'thinking'
  text?: string;        // type === 'text'
  toolCall?: ToolCallContent; // type === 'tool_call'
}
```

追加规则（`appendThinkingBlock` / `appendTextBlock`）：
- 同类型末尾块直接拼接 delta（thinking 累加到 thinking、text 累加到 text）
- 类型切换时新建块
- `turn_start` 记录 `currentTurnBlockStartIndex`，`replaceTextBlocksFrom` 在文本回缩时从该索引重建 text 块，避免跨轮文本跳跃/重复

工具调用按 ID 合并（`mergeStreamedToolCalls`），跨轮累积，不会被后一轮的空 `toolCalls` 覆盖。

### 2.2 InlineCallTraceEntry — 渲染条目

`buildInlineCallTrace`（`src/renderer/components/chat/call-trace-view-model.ts`）把 `blocks` 投影成渲染条目：

```typescript
type InlineCallTraceEntry =
  | { kind: 'thinking'; id: string; text: string; isCurrent: boolean; isActive: boolean }
  | { kind: 'text';     id: string; text: string; isCurrent: boolean; isActive: boolean }
  | { kind: 'tools';    id: string; label: string; toolCalls: ToolCallContent[]; isCurrent: boolean; hasRunning: boolean; hasFailed: boolean; isActive: boolean };
```

- **`isActive`**：流式态下，末尾连续同类型的 block 视为活跃（正在追加 delta）。`sortEntriesByActiveLast` 把活跃条目排到末尾，让"正在发生的事"始终在底部。
- **`isCurrent`**：排序后的最后一条标记为 `isCurrent`，用于区分"当前进行中"与"已完成的历史"。
- 相邻同种类工具调用合并为一个 `tools` 条目（`pushToolGroup` / `canMergeToolGroups`），减少视觉碎片。

---

## 3. 渲染分层

`AssistantMessage.vue` 区分流式态与完成态两条渲染路径：

| 阶段 | 头部 | 主体 | 说明 |
|------|------|------|------|
| 流式中 | `inline-trace-live`：旋转点 + "处理中 Ns" | `InlineCallTrace` 流式视图 | 时间轴顺序铺开，活动条目在底部 |
| 完成后 | — | `.message-content`（最终回复）+ `<details>` 折叠的 `processEntries` | 最终回复直接呈现；工具/思考轨迹按需展开 |

完成态的 `processEntries = visibleEntries.filter(e => e.kind !== 'text')` —— **text 块不进折叠区**，避免最终回复在主区域和轨迹里重复显示。

### 3.1 `showThinking` 设置开关

`AppSettings.showThinking`（默认 `true`，`src/shared/types.ts`）控制是否展示纯思考文字。设置入口在"行为"→"思考深度"同一张卡片（`SettingsPanel.vue`）。

`AssistantMessage.vue` 据此过滤：

```typescript
const showThinking = computed(() => settingsStore.settings.showThinking !== false);
const visibleEntries = computed(() =>
  showThinking.value
    ? inlineTrace.value.entries
    : inlineTrace.value.entries.filter((entry) => entry.kind !== 'thinking'),
);
```

- 关闭后，`kind === 'thinking'` 条目在流式态与完成态都不渲染
- **工具/命令条目始终保留** —— 它们是"运行逻辑"，不受开关影响
- 最终回复文本（`text` 块）也始终可见
- 开关通过 `:show-thinking` prop 透传给 `InlineCallTrace`，subagent 递归实例一并生效

> 注意：`showThinking`（是否展示思考过程）与 `thinkingLevel`（模型推理强度 minimal/low/medium/high/xhigh）是两回事。前者是 UI 显示控制，后者是模型参数。

---

## 4. 流式时间轴渲染（`InlineCallTrace.vue`）

流式视图按 `entries` 顺序渲染，三类条目三种呈现：

### 4.1 思考（thinking）

```html
<div v-if="showThinking && entry.kind === 'thinking'" class="streaming-thinking-text">
  <StreamingText :text="entry.text" :is-streaming="isStreaming && entry.isActive" />
</div>
```

受 `showThinking` 门控。流式态不按 UI 语言过滤（模型常用英文思考、用 UI 语言回复，过滤会让等待期空白）。

### 4.2 中间文本（text && !isCurrent）—— 一行预览，可展开

```html
<details v-else-if="entry.kind === 'text' && !entry.isCurrent'" class="streaming-intermediate-details">
  <summary class="streaming-intermediate-summary">
    <span class="streaming-intermediate-preview">{{ intermediatePreview(entry.text) }}</span>
  </summary>
  <div class="streaming-intermediate-full">
    <StreamingText :text="entry.text" :is-streaming="false" />
  </div>
</details>
```

`intermediatePreview` 取首行、压成一行、截断到 120 字符加省略号：

```typescript
const INTERMEDIATE_PREVIEW_LIMIT = 120;
function intermediatePreview(text: string): string {
  const firstLine = (text.trim().split('\n')[0] ?? '').trim();
  const collapsed = firstLine.replace(/\s+/g, ' ');
  if (collapsed.length <= INTERMEDIATE_PREVIEW_LIMIT) return collapsed;
  return `${collapsed.slice(0, INTERMEDIATE_PREVIEW_LIMIT)}…`;
}
```

点击 `▸` 展开看完整叙述。这是"中间大模型输出太长 → 给一个摘要"的落地——**采用前端截断 + 可展开，不额外发模型请求**，理由见 §6。

### 4.3 实时输出（text && isCurrent）—— 完整流式

```html
<div v-else-if="entry.kind === 'text' && entry.isCurrent" class="streaming-live-text">
  <StreamingText :text="entry.text" :is-streaming="isStreaming" />
</div>
```

正在写的活动文字块完整实时显示，让用户看到模型当前在说什么。

### 4.4 工具/命令（tools）

```html
<details v-else class="streaming-tool-details" :class="[statusClass, { current: entry.isCurrent }]">
  <summary class="streaming-tool-row">
    <span class="streaming-tool-dot" :class="statusClass" />
    <span class="streaming-tool-text">{{ streamingToolText(entry) }}</span>
  </summary>
  <div class="streaming-tool-detail">
    <ToolMarkdownOutput :output="toolOutput(call)" :command="..." :is-streaming="call.status === 'running'" />
  </div>
</details>
```

状态点：运行中（accent 呼吸动画）/ 失败（红）/ 完成（绿）。运行中的条目有 shimmer 扫光。subagent 工具递归渲染子 Agent 的内部轨迹（`buildSubagentInlineTrace`）。

### 4.5 整体时间轴效果

```
▸ Let me check the file first…            ← 中间文本预览（可展开）
▶ 已运行 1 条命令  ls src/                  ← 工具（可展开看输出）
▸ Now I'll edit the config…                 ← 中间文本预览
▶ 已运行 1 个工具  编辑 config.ts            ← 工具
正在实时输出的最终回答……                     ← 实时输出（活动 text）
```

---

## 5. 为什么流式期间不标"最终回答"

历史版本曾把 `text && isCurrent` 的活动文字块标为"最终回答"。这是**误判**：

- `isCurrent` = 排序后的最后一条。模型正在写一段中间叙述（之后还会调工具）时，这段文字恰好也是最后一条 → 被误判成"最终回答"
- 等工具一开始，它又翻回成中间预览，造成"不是最终回答却显示最终回答"的闪烁

**根因**：流式过程中**无法可靠判断**当前正在写的文字是不是最终回答——只有 `message_end` 之后才知道。

**决策**：流式期间不给"最终回答"标签，活动文字块直接以中性方式完整流式显示；真正的最终回答在流式结束后由主回复区 `.message-content` 呈现（完成态 `processEntries` 不含 text 块，不会重复）。这样消除了误判闪烁，且不丢失任何信息。

---

## 6. 中间文本"摘要"为何用前端截断而非模型摘要

曾考虑当中间文本过长时额外发一次模型请求生成一句话摘要。最终选择**前端截断 + 可展开**：

| 维度 | 前端截断 | 额外模型请求 |
|------|---------|-------------|
| 延迟 | 0 | 一次往返 |
| 费用 | 0 | 每个中间块一次调用 |
| 实现层 | 仅渲染层 | 需新铺 IPC → main → worker 通路 |
| 信息完整 | 展开可见全文 | 摘要可能丢细节 |

UI 的目标是"看到整体运行逻辑"，首行预览已足够；额外模型调用性价比低，且与"渲染层改动"的边界冲突。如未来确实需要真·AI 摘要，作为独立第二批改动新增轻量补全 IPC。

---

## 7. 关键源码

| 模块 | 路径 |
|------|------|
| ChatMessage / blocks 状态 | `src/renderer/stores/chat.ts` |
| InlineCallTraceEntry 构建 / 排序 | `src/renderer/components/chat/call-trace-view-model.ts` |
| AssistantMessage 分层渲染 | `src/renderer/components/chat/AssistantMessage.vue` |
| 流式时间轴组件 | `src/renderer/components/chat/InlineCallTrace.vue` |
| 流式 Markdown 渲染 | `src/renderer/components/chat/StreamingText.vue` |
| showThinking 设置 | `src/renderer/components/settings/SettingsPanel.vue`、`src/shared/types.ts` |
| 设置 store | `src/renderer/stores/settings.ts` |