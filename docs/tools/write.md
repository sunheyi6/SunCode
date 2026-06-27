# write 工具 — 设计文档

## 1. 概述

write 是 SunCode 的新建/覆盖写入工具。v2 接入 `file-mutation-queue`（文件并发锁），确保与 edit 工具到同一文件时不会竞态。

---

## 2. 核心流程

```
┌──────────────────────────────────────┐
│           write.ts (工具入口)          │
│                                      │
│  1. 路径校验（禁止写出工作目录）       │
│  2. 内容必填校验                      │
│                                      │
│  3. withFileMutationQueue(absPath)   │
│     │                                │
│     ▼                                │
│  4. 读旧内容（如果存在）              │
│     │                                │
│     ▼                                │
│  5. mkdir -p 父目录                  │
│     │                                │
│     ▼                                │
│  6. writeFile(absPath, content)      │
│     │                                │
│     ▼                                │
│  7. countLineChanges(旧, 新)         │
│     │                                │
│     ▼                                │
│  8. 返回 ToolResult                  │
└──────────────────────────────────────┘
```

---

## 3. 文件并发锁

### 3.1 问题

agent-loop 用 `Promise.allSettled()` 并行执行工具。同一轮发 `write` + `edit` 到同一文件：

```
write → writeFile("app.ts", ...) ─┐
                                   ├─ 竞态：edit 可能读到中间态
edit  → readFile("app.ts")      ─┘
```

### 3.2 解决：`withFileMutationQueue()`

见 `docs/tools/edit.md` 第 6 节，"文件并发锁" 完整说明。

write 和 edit 共享同一个全局 `fileMutationQueues` Map，按物理文件路径排队。

---

## 4. 安全措施

| 措施 | 实现 |
|------|------|
| 路径限制 | 禁止写出工作目录之外 |
| 内容必填 | content 为 undefined 时拒绝 |
| 同文件串行 | `withFileMutationQueue()` 防止竞态 |
| 文件存在保护 | 覆盖前读旧内容（用于 diff 统计） |

---

## 5. 参数设计

```json
{
  "file_path": "src/new-file.ts",
  "content": "import { foo } from './bar';\n\nexport function hello() {\n  return 'world';\n}\n"
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `file_path` | string | ✅ | 文件路径（相对或绝对） |
| `content` | string | ✅ | 文件内容 |

---

## 6. 输出格式

```
File written successfully: /project/src/new-file.ts
3 added, 0 removed
```

---

## 7. 与 edit 的协同

| 场景 | 行为 |
|------|------|
| write 新文件 → edit 同一文件（同轮） | mutation queue 串行：先 write 完，再 edit |
| edit → write 同一文件（同轮） | mutation queue 串行：先 edit 完，再 write |
| write A, write B（不同文件） | 并行执行（不同 queue key） |
| write A, edit A, edit B（A 串行，B 并行） | A 排队，B 不阻塞 |

---

## 8. 关键文件

| 文件 | 职责 |
|------|------|
| `src/worker/tools/write.ts` | 工具入口，文件创建/覆盖 |
| `src/worker/tools/file-mutation-queue.ts` | 文件并发串行锁 |
| `src/worker/tools/line-diff.ts` | 行变更统计 |
