# grep 工具 — 设计文档

## 1. 概述

grep 是 SunCode 的内容搜索工具，底层调用 ripgrep。v2 从 pi-1 迁移了 **JSON 输出解析**、**文件缓存上下文**、**字面量搜索**、**提前 kill** 四个关键改进，解决了纯文本解析脆弱、隐藏文件漏搜、大仓库效率低等问题。

---

## 2. 核心流程

```
┌────────────────────────────────────────────────┐
│             grep.ts (工具入口)                  │
│                                                │
│  1. stat(searchPath) → 是目录还是文件?          │
│  2. 构建 rg 参数                                │
│  3. spawn('rg', ['--json', ...])               │
│     │                                          │
│     ▼                                          │
│  readline 逐行解析 JSON:                        │
│  { type: "match", data: {                      │
│      path: { text: "src/app.ts" },             │
│      line_number: 42,                          │
│      lines: { text: "const x = 1;" }           │
│  }}                                            │
│     │                                          │
│     ├── matchCount++                            │
│     ├── 达 limit? → child.kill() 提前终止      │
│     └── 存入 matches[]                          │
│     │                                          │
│     ▼                                          │
│  rg 进程结束 → 格式化输出                        │
│     │                                          │
│     ├── context=0 + 有 lineText                 │
│     │   → 直接截断行输出                         │
│     │                                          │
│     └── context>0                               │
│         → 读文件取上下文行（fileCache 缓存）     │
│     │                                          │
│     ▼                                          │
│  truncateHead() → 截断到 50KB                   │
│  truncateLine() → 单行截断到 500 字符           │
│     │                                          │
│     ▼                                          │
│  返回 ToolResult                                │
└────────────────────────────────────────────────┘
```

---

## 3. JSON 输出解析

### 3.1 为什么不用纯文本解析

v1 用 `--no-heading` 纯文本：

```
src/app.ts:42:const x = 1;
```

问题：

- 路径含空格/特殊字符时解析困难
- 带 context 行时格式变化
- 跨平台差异（Windows 路径 `\` vs `/`）

### 3.2 `--json` 结构化输出

ripgrep 的 `--json` 每行一个 JSON 对象：

```json
{"type":"begin","data":{"path":{"text":"src/app.ts"}}}
{"type":"match","data":{"path":{"text":"src/app.ts"},"lines":{"text":"const x = 1;"},"line_number":42,"absolute_offset":1234,"submatches":[...]}}
{"type":"end","data":{"path":{"text":"src/app.ts"},"stats":{"matches":1,...}}}
```

只处理 `type === "match"` 的事件，逐条取 `path.text`、`line_number`、`lines.text`。

---

## 4. 文件缓存上下文

### 4.1 问题

v1 用 rg 的 `-C` 参数取上下文行，但 `--json` 模式下 `-C` 输出的上下文行格式不稳定。

### 4.2 解决：自己读文件

```typescript
const fileCache = new Map<string, string[]>();

const getFileLines = async (filePath: string): Promise<string[]> => {
    let lines = fileCache.get(filePath);
    if (!lines) {
        const content = await readFile(filePath, 'utf-8');
        lines = content.replace(/\r\n/g, '\n').split('\n');
        fileCache.set(filePath, lines);  // 缓存，避免重复读
    }
    return lines;
};
```

同一文件被多个匹配命中时，`fileCache` 保证只读一次。

### 4.3 上下文行格式

```
src/app.ts:40: import { B } from 'y';       ← 上下文行
src/app.ts:41:                               ← 上下文行
src/app.ts:42: const x = 1;                  ← 匹配行
src/app.ts:43: export default x;             ← 上下文行
src/app.ts:44:                               ← 上下文行
```

匹配行用 `:` 分隔，上下文行用 `-` 分隔。

---

## 5. 提前 kill

### 5.1 问题

大仓库中 rg 可能匹配数万行，全部解析完再截断浪费 CPU 和时间。

### 5.2 实现

```typescript
rl.on('line', (line) => {
    // ... 解析 JSON ...
    if (matchCount >= effectiveLimit) {
        matchLimitReached = true;
        if (!child.killed) child.kill();  // 立即杀 rg
    }
});
```

---

## 6. 截断保护

### 6.1 行级截断

```typescript
function truncateLine(line: string, maxLength = 500) {
    if (line.length <= maxLength) return { text: line, wasTruncated: false };
    return { text: line.slice(0, maxLength) + '…', wasTruncated: true };
}
```

### 6.2 总输出截断

```typescript
function truncateHead(text, { maxBytes = 50000, maxLines }) {
    // 按行收集，每到 byte 限制为止（不拆行）
}
```

### 6.3 截断提示

```
[100 matches limit reached. Use limit=200 for more, or refine pattern. Some lines truncated to 500 chars. Use read tool to see full lines]
```

---

## 7. 参数设计

```json
{
  "pattern": "import.*from",
  "path": "src/",
  "glob": "*.ts",
  "type": "ts",
  "ignoreCase": false,
  "literal": false,
  "multiline": false,
  "context": 3,
  "limit": 100
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `pattern` | string | ✅ | 正则或字面量（`literal=true`） |
| `path` | string | ❌ | 搜索路径，默认 workingDir |
| `glob` | string | ❌ | 文件过滤 glob（如 `*.ts`） |
| `type` | string | ❌ | rg 文件类型（`js`/`py`/`rust`） |
| `ignoreCase` | boolean | ❌ | 忽略大小写 |
| `literal` | boolean | ❌ | 字面量匹配（`--fixed-strings`） |
| `multiline` | boolean | ❌ | 多行模式 |
| `context` | number | ❌ | 上下文行数 |
| `limit` | number | ❌ | 匹配上限，默认 100 |

---

## 8. 输出格式

```
Found 3 matches:

src/app.ts:42: import { Tool } from '@/types';
src/utils/helper.ts:15: import { readFile } from 'fs';
src/shared/constants.ts:8: import type { Config } from './config';

[3 matches limit reached]
```

---

## 9. 关键文件

| 文件 | 职责 |
|------|------|
| `src/worker/tools/grep.ts` | 工具入口，rg 进程管理，JSON 解析，截断 |
| `src/worker/agent/system-prompt.ts` | LLM 指令：grep 使用说明 |
