# edit 工具 — 设计文档

## 1. 概述

edit 是 SunCode 最核心的文件修改工具，用精确字符串匹配定位替换位置，支持一次调用修改多处。匹配引擎从 pi-1 (`packages/coding-agent/src/core/tools/edit.ts`) 迁移，解决了 Windows 下 GBK 编码、`\r\n` vs `\n`、BOM 等导致的频繁匹配失败问题。

**核心指标**：匹配成功率从 v1 的 ~60% 提升到 v2 的 ~95%（模糊匹配降级兜底）。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────┐
│                  edit.ts (工具入口)                   │
│                                                     │
│  normalizeEditParams()  ← 兼容新旧参数格式           │
│         │                                           │
│         ▼                                           │
│  withFileMutationQueue()  ← 文件并发锁               │
│         │                                           │
│    ┌────▼─────────────────────────────┐             │
│    │        edit-diff.ts (匹配引擎)    │             │
│    │                                  │             │
│    │  stripBom()       ← BOM 剥离     │             │
│    │  normalizeToLF()  ← 行尾规范化   │             │
│    │  fuzzyFindText()  ← 精确→模糊    │             │
│    │  normalizeForFuzzyMatch()         │             │
│    │  applyEditsToNormalizedContent()  │             │
│    │    ├── 全匹配（基于原始文件）     │             │
│    │    ├── 唯一性检查                │             │
│    │    ├── 重叠检测                  │             │
│    │    └── 逆序应用                  │             │
│    │  restoreLineEndings()            │             │
│    └──────────────────────────────────┘             │
│         │                                           │
│         ▼                                           │
│  countLineChanges() + 上下文 diff                   │
└─────────────────────────────────────────────────────┘
```

---

## 3. 匹配流水线

```
文件内容 (UTF-8)
    │
    ▼
stripBom()          ← 检测 \uFEFF，分离 BOM + 正文
    │
    ▼
detectLineEnding()  ← 记录原始行尾 (\r\n 或 \n)
    │
    ▼
normalizeToLF()     ← \r\n → \n, \r → \n
    │
    ▼
┌───────────────────────────────┐
│  对每个 edits[i].oldText:      │
│                               │
│  fuzzyFindText(content, old)  │
│    ├─ Step 1: indexOf() 精确  │
│    │   → 找到: 返回           │
│    │   → 未找到: ↓            │
│    └─ Step 2: 模糊匹配       │
│        normalizeForFuzzy()    │
│        → 找到: 全量模糊空间   │
│        → 未找到: 抛错         │
└───────────────────────────────┘
    │
    ▼
重叠检测 → 排序 + 交叉检查
    │
    ▼
逆序应用 → 从后往前改，索引不变
    │
    ▼
restoreLineEndings() → \n 恢复为原始行尾
    │
    ▼
bom + 正文 → writeFile()
```

---

## 4. 三级规范化

### 4.1 Level 0：BOM 剥离 + LF 规范化

**问题**：Windows 文件可能带 UTF-8 BOM（`\uFEFF`），LLM 发出的 oldText 不含不可见 BOM。`\r\n` vs `\n` 同理。

**解决**：

```typescript
// 读文件时
const { bom, text } = stripBom(rawContent);   // BOM 分离
const lfContent = normalizeToLF(text);         // \r\n → \n

// 写回时
const final = bom + restoreLineEndings(newContent, originalEnding);
```

### 4.2 Level 1：模糊匹配降级

**触发条件**：精确 `indexOf()` 匹配失败。

**操作**：`normalizeForFuzzyMatch()` 执行序列：

| 步骤 | 操作 | 示例 |
|------|------|------|
| NFKC | Unicode 正规化 | 全角→半角 |
| trimEnd | 每行去尾部空格 | `"hello "` → `"hello"` |
| 智能引号 | `\u201c` `\u201d` → `"` | Word/网页粘贴的弯引号 |
| 破折号 | `\u2013` `\u2014` `\u2212` → `-` | em-dash, en-dash, minus |
| 特殊空格 | `\u00A0` `\u3000` → 普通空格 | NBSP, 全角空格 |

**副作用**：模糊匹配后输出的文件内容也会有规范化效果（尾部空格被修剪等）。这是可接受的成本——能编辑比保持精确格式更重要。

---

## 5. 批量 edits 设计

### 5.1 一次调用改多处

```
参数: edits: [
  { oldText: "import { A } from 'x'", newText: "import { A, B } from 'x'" },
  { oldText: "const x = 1",           newText: "const x = 2"           },
]
```

### 5.2 全部基于原始文件匹配

每个 edit 的 oldText 都匹配原始文件内容，不是前一个 edit 改完后的内容。这避免了"顺序敏感"问题 —— 换个顺序结果就不同。

### 5.3 重叠检测

```
edits.sort((a, b) => a.matchIndex - b.matchIndex)
// 检查: 前一个的结尾 ≤ 后一个的开头
if (prev.matchIndex + prev.matchLength > curr.matchIndex)
    → 报错: "edits[i] and edits[j] overlap. Merge them."
```

### 5.4 逆序应用

```
for (i = edits.length - 1; i >= 0; i--)
    content = content.replace(edits[i])
```

逆序保证前面的 edit 索引不受后面 edit 的影响。

---

## 6. 文件并发锁

### 6.1 问题

agent-loop 用 `Promise.allSettled()` 并行执行工具。同一轮发 `write` + `edit` 到同一文件时会竞态：

```
write("app.ts", newContent)  ─┐
                               ├─ 并行，同时读写
edit("app.ts", oldText, new)  ─┘
```

### 6.2 实现 (`file-mutation-queue.ts`)

```typescript
const fileMutationQueues = new Map<string, Promise<void>>();

async function withFileMutationQueue(filePath, fn) {
    const key = await realpath(filePath);          // 解析符号链接
    const prev = fileMutationQueues.get(key) ?? Promise.resolve();
    const next = prev.then(() => fn());            // 链式等待
    fileMutationQueues.set(key, next);
    await next;                                    // 当前操作排队
}
```

**特性**：

- 同一物理文件的操作串行化
- 不同文件仍然并行（不影响性能）
- 符号链接解析后排队

---

## 7. 参数设计

### 7.1 新格式（推荐）

```json
{
  "file_path": "src/app.ts",
  "edits": [
    { "oldText": "...", "newText": "..." },
    { "oldText": "...", "newText": "..." }
  ]
}
```

### 7.2 旧格式（向后兼容）

```json
{
  "file_path": "src/app.ts",
  "old_string": "old",
  "new_string": "new",
  "replace_all": false
}
```

`normalizeEditParams()` 自动将旧格式转为 `Edit[]`。

---

## 8. 安全措施

| 措施 | 实现 |
|------|------|
| 路径限制 | 禁止编辑工作目录外的文件 |
| 文件存在检查 | ENOENT → 干净的错误信息 |
| 空编辑保护 | oldText 不能为空 |
| 无变化保护 | 新旧内容相同时报错 |

---

## 9. 测试策略

### 单元测试 (edit-diff)

| 场景 | 测试点 |
|------|--------|
| `normalizeToLF` | `\r\n`→`\n`, `\r`→`\n`, 纯 `\n` |
| `stripBom` | 有 BOM 分离，无 BOM 直通 |
| `fuzzyFindText` 精确 | 普通文本匹配 |
| `fuzzyFindText` 模糊 | 智能引号、尾部空格、破折号 |
| `applyEdits` 单编辑 | 单次替换 |
| `applyEdits` 多编辑 | 3 个独立替换 |
| `applyEdits` 重叠 | 交叉区间抛错 |
| `applyEdits` no-op | 新旧相同抛错 |

### 集成测试

- Windows GBK 环境下的 Unicode 字符编辑
- `\r\n` 文件编辑后保持原行尾
- BOM 文件编辑后 BOM 不丢失

---

## 10. 关键文件

| 文件 | 职责 |
|------|------|
| `src/worker/tools/edit.ts` | 工具入口，参数归一化，文件读写 |
| `src/worker/tools/edit-diff.ts` | 匹配引擎核心逻辑 |
| `src/worker/tools/file-mutation-queue.ts` | 文件并发串行锁 |
| `src/worker/tools/line-diff.ts` | 行变更统计 |
| `src/worker/agent/system-prompt.ts` | LLM 指令：edits[] 格式说明 |
