# 失败教训自动记录与检索系统 — 设计文档

日期: 2026-06-28 | 状态: 已实现

---

## 概述

在编码 agent 对话过程中，当 LLM 执行失败、用户纠正、或目标验证反复失败时，自动提取关键教训并存储到 `.suncode/lessons/`。后续会话中，agent 可通过 `search_lessons` 工具按需检索相关教训，避免重复犯同样的错误。

**核心原则：**

- 教训（learned）与 AGENTS.md（explicit）分离
- 按需检索，不注入系统提示
- 后台异步提取，不阻塞 run 完成
- 用户可配置存储上限

---

## 架构

```
┌─ 触发层 ───────────────────────────────────────────────┐
│  runLoop() / runGoalLoop() 结束后检测：                  │
│  · tool_failure — ToolResult.success === false           │
│  · user_correction — 下一轮用户消息含否定/纠正语义        │
│  · run_error — run 以 error/blocked taxonomy 结束        │
│  · goal_repeated_failure — 验证连续 2 次返回相同失败      │
│                                                        │
│  → extractLessonsIfNeeded() 异步 fire-and-forget         │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ 提取层 ───────────────────────────────────────────────┐
│  轻量 LLM（LITE_MODELS）提取结构化教训                    │
│  · JSON 输出 → title/problem/rootCause/solution/keywords │
│  · 去重：相似度 > 80% 跳过                                │
│  · 限流：同 run 最多 3 条，同类型+工具 24h 内 1 条        │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ 存储层 ───────────────────────────────────────────────┐
│  .suncode/lessons/                                      │
│  ├── LESSONS.md              ← 合并索引                  │
│  └── {date}-{slug}.md        ← 单条教训（≤2KB）          │
│                                                        │
│  与 .suncode/memories/ 互补但不互相替代                   │
  · memories: 做了什么（正向总结）                         │
  · lessons: 什么不该做/该怎么做（负向教训）                │
  详见：memory-system-design.md                            │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ 检索层 ───────────────────────────────────────────────┐
│  路径 1: search_lessons 工具（主要）                      │
│    · agent 主动调用，关键词匹配                           │
│    · isReadonly: true，所有权限模式可用                   │
│                                                        │
│  路径 2: 工具结果增强（兜底）                              │
│    · 工具执行失败时，自动追加匹配的教训提示                 │
│    · 只给 nudge，不注入完整内容                            │
│                                                        │
│  结果按时间倒序排列，最新的在前                             │
└────────────────────────────────────────────────────────┘
```

---

## 类型定义

```typescript
// shared/types.ts

export type LessonTriggerType =
  | 'tool_failure'
  | 'user_correction'
  | 'run_error'
  | 'goal_repeated_failure';

export interface LessonEntry {
  /** 文件名中的 slug */
  slug: string;
  /** 触发类型 */
  type: LessonTriggerType;
  /** 涉及的工具名 */
  tool: string;
  /** 关键词 */
  keywords: string[];
  /** 相关文件路径 */
  files: string[];
  /** ISO 日期 */
  date: string;
  /** 来源 runId */
  runId: string;
  /** 一句话标题（中文，≤30字） */
  title: string;
  /** 问题描述（≤200字） */
  problem: string;
  /** 根本原因（≤200字） */
  rootCause: string;
  /** 正确做法（≤200字） */
  solution: string;
}

export interface LessonIndex {
  /** 各类型下的条目（按日期倒序） */
  entries: LessonEntry[];
  /** 最后更新时间 */
  updatedAt: string;
}

export interface LessonSearchResult {
  entry: LessonEntry;
  score: number;
}

export interface LessonExtractionContext {
  triggerType: LessonTriggerType;
  relevantMessages: Message[];
  error?: string;
  runId: string;
}
```

---

## Settings 扩展

```typescript
// AppSettings 新增字段
{
  // ...existing fields
  /** 最多保留的教训条数，默认 200 */
  maxLessons: number;
}
```

---

## 文件清单

```
src/
├── shared/
│   ├── types.ts              ← +LessonEntry, LessonIndex 等类型
│   └── constants.ts          ← +DEFAULT_MAX_LESSONS = 200
├── worker/
│   ├── agent/
│   │   ├── lessons.ts         ← 🆕 教训存储/检索核心模块（约 300 行）
│   │   ├── agent.ts           ← +runLoop()/runGoalLoop() 后调用
│   │   └── agent-loop.ts      ← +工具结果增强（失败时匹配）
│   └── tools/
│       ├── search-lessons.ts  ← 🆕 search_lessons 工具
│       └── registry.ts        ← +注册
├── renderer/
│   └── stores/
│       └── settings.ts        ← +maxLessons 默认值
```

---

## 关键约束

1. **提取不阻塞 run 返回** — `extractLessonsIfNeeded()` 是 fire-and-forget
2. **教训不注入系统提示** — LESSONS.md 不在 `buildSystemPrompt` 中加载
3. **工具结果增强只追加一行提示** — 不追加完整教训，保护 context budget
4. **最大容量由用户配置** — Settings → maxLessons，默认 200
5. **搜索结果按时间倒序** — 最新的教训排最前

---

## 参考

- OpenAI Codex Memories: <https://developers.openai.com/codex/memories>
- Codex Issue #8368 (Long-term Memory): <https://github.com/openai/codex/issues/8368>
