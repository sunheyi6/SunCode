# Session Title Generation

## 1. Problem / Design Goal

SunCode 在用户发送第一条消息时自动为会话生成标题。原来的实现仅截取首行前 30
个字符，产生的标题质量差（如截断在词中、包含 markdown 格式符号、过长或过短）。

需要一个更智能的标题生成策略：遵循指定的提示词规则，产出 3-7 词、无格式噪音、
可辨识的简洁标题，并为后续接入 AI 模型生成标题预留接口。

## 2. Architecture

```
用户首条消息
    │
    ▼
session:saveMessage (IPC)
    │
    ▼
extractTitle(message) ─── 使用 TITLE_GENERATION_PROMPT 规则清理文本
    │
    ▼
meta.name = title
    │
    ▼
saveSession(meta, msgs)
```

- `TITLE_GENERATION_PROMPT` 定义在 `src/shared/constants.ts`，作为标题生成的规则
  提示词，主进程和 worker 线程均可引用。
- `extractTitle` 位于 `src/main/ipc-handlers.ts`，当前为基于规则的纯文本清理实现。
- 未来可扩展为异步 AI 调用：将 `TITLE_GENERATION_PROMPT` + 首条消息发送给轻量
  模型，由模型返回 `{"title":"..."}` JSON。

## 3. Implementation Details

### 3.1 标题生成提示词 (`src/shared/constants.ts`)

```ts
export const TITLE_GENERATION_PROMPT = `Generate a concise title for this coding session.

Rules:
- Use the user's primary language.
- Use 3-7 words when possible.
- Keep it recognizable in a session list.
- Preserve important proper nouns, file names, APIs, and technology names.
- Do not use markdown, numbering, quotes, trailing punctuation, or explanations.
- Return only JSON in this shape: {"title":"..."}`;
```

### 3.2 extractTitle 函数 (`src/main/ipc-handlers.ts`)

当前为基于规则的清理实现，流程：

1. **提取文本**：从 Message.content（支持 string 和 ContentBlock[] 两种格式）中
   提取纯文本。
2. **取首行**：跳过空行，取第一个非空行。
3. **清理格式**：
   - 移除 markdown 标记 (`#`、`*`、`_`、`~`)
   - 移除行内代码 (`` ` ``)
   - 移除链接括号 (`[]()`)
   - 移除引号（中英文）
   - 移除尾部标点
   - 合并多余空白
4. **截断到 7 词**：超过 7 词时截断，并移除尾部功能词（的、了、the、a、an
   等），避免断句突兀。
5. **最终截断**：超过 50 字符时硬截断。

```ts
function extractTitle(message: Message): string | null {
  // 1. 提取纯文本
  let text = '';
  if (typeof message.content === 'string') {
    text = message.content;
  } else {
    text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join(' ');
  }
  if (!text.trim()) return null;

  // 2. 取首行
  const firstLine = text.split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  if (!firstLine) return null;

  // 3. 清理格式
  let cleaned = firstLine
    .replace(/^[#>*-]+/, '')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/[*_~]{1,2}/g, '')
    .replace(/[\[\]\(\)]/g, '')
    .replace(/["「」『』"']/g, '')
    .replace(/[.。,，!！?？;；:：、]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  // 4. 限制 7 词
  const words = cleaned.split(/\s+/);
  if (words.length > 7) {
    cleaned = words.slice(0, 7).join(' ');
    cleaned = cleaned.replace(
      /\s+(的|了|吗|呢|吧|啊|哦|嗯|和|与|或|the|a|an|in|on|at|to|for|of|and|or|but)$/i,
      '',
    );
  }

  // 5. 硬截断 50 字符
  if (cleaned.length > 50) {
    cleaned = cleaned.slice(0, 50).replace(/\s+\S*$/, '');
  }
  return cleaned || null;
}
```

## 4. Design Decisions & Trade-offs

| 决策 | 理由 | 权衡 |
|------|------|------|
| 当前用规则清理而非 AI 调用 | 同步执行，无延迟；AI 调用需要异步改造整个保存链路 | 无法理解语义，无法智能提取"关键名词" |
| 提示词存储在 `constants.ts` | 主进程和 worker 均可引用，为未来 AI 生成做准备 | 暂无 |
| 标题生成在 `session:saveMessage` 中触发 | 与消息保存原子执行，不增加额外 IPC | AI 生成会导致保存变慢，需改为异步 |
| 7 词 / 50 字符限制 | 符合提示词"3-7 words"规则和列表展示空间 | 可能截断有意义的标题 |

## 5. Lessons Learned

- 当前基于规则的清理对于中文消息效果较好，但对复杂英文技术问题（如包含大量
  代码片段的提问）效果有限。
- 未来如果接入 AI 标题生成，需要：
  1. 将 `session:saveMessage` 中的标题更新改为异步（先保存默认标题，AI 返回后
     再更新）。
  2. 考虑使用轻量/便宜模型（避免标题生成消耗过多 token）。
  3. 在 `WorkerInMessage` 中新增 `generateTitle` 消息类型，worker 处理后通过
     `WorkerOutMessage` 返回标题。
