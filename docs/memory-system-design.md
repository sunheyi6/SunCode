# 记忆系统设计文档

日期: 2026-07-11 | 状态: 已实现

---

## 概述

SunCode 的记忆系统旨在帮助 AI agent 在跨会话间持久化和复用重要信息，实现真正的"长期记忆"能力。系统采用混合检索机制（关键词匹配 + 向量相似度），支持结构化事实提取、时间有效性管理、场景聚类等高级特性，并提供完整的用户交互界面。

**核心原则：**

- **双向记忆**：自动记录（会话总结）+ 手动添加（用户输入）
- **时间感知**：支持记忆的有效期管理
- **场景聚类**：相似记忆自动归组
- **透明可见**：用户可查看、搜索、删除记忆
- **检索增强**：聊天中展示引用的记忆，点击可查看详情

---

## 架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          用户界面层                                      │
│  ┌───────────────┐    ┌───────────────┐    ┌─────────────────────┐     │
│  │ 设置 - 记忆   │    │ 聊天 - 引用    │    │ 记忆详情弹窗        │     │
│  │ · 添加记忆    │    │ · 显示引用     │    │ · 完整信息          │     │
│  │ · 搜索记忆    │    │ · 点击查看     │    │ · 删除操作          │     │
│  │ · 删除记忆    │    │ · 详情弹窗     │    │ · 结构化事实        │     │
│  └───────────────┘    └───────────────┘    └─────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ IPC
┌─────────────────────────────────────────────────────────────────────────┐
│                          主进程层                                        │
│  preload.ts  ← IPC API 桥接                                              │
│  ipc-handlers.ts  ← 记忆操作处理器                                        │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ postMessage
┌─────────────────────────────────────────────────────────────────────────┐
│                          Worker 层                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                        记忆核心模块                                   │ │
│  │  memory.ts                                                           │ │
│  │  ├── 存储管理   → .suncode/memories/{scope}/{date}-{slug}.md         │ │
│  │  ├── 索引管理   → MEMORY.md / MEMORY.json                            │ │
│  │  ├── 场景聚类   → scenes/{sceneId}.json                              │ │
│  │  ├── 混合检索   → 关键词匹配 + 向量相似度                              │ │
│  │  ├── 事实提取   → LLM 提取结构化事实                                   │ │
│  │  └── 合并清理   → 定期合并相似记忆                                     │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                        Agent 集成                                    │ │
│  │  agent.ts  → loadMemoriesWithEntries() 加载记忆                       │ │
│  │  agent-loop.ts  → 传递 memoryEntries 到消息结束事件                    │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 数据模型

### 核心类型

```typescript
// shared/types.ts

export type MemoryScope = 'session' | 'project';
export type MemoryKind =
  | 'task_summary'    // 任务摘要（自动）
  | 'project_fact'    // 项目事实（手动/自动）
  | 'decision'        // 决策（手动/自动）
  | 'preference'      // 用户偏好（手动/自动）
  | 'lesson'          // 经验教训（自动）
  | 'ephemeral';      // 临时记忆（自动）

export interface StructuredFact {
  type: 'fact' | 'preference' | 'decision';
  subject: string;       // 主语，如 "项目"、"用户"
  predicate: string;     // 谓语，如 "使用"、"喜欢"
  object: string;        // 宾语，如 "Vue 3"、"TypeScript"
  validity: { start: string; end?: string };  // 有效时间范围
  confidence: number;    // 置信度 0-1
}

export interface MemoryEntry {
  date: string;                  // ISO 日期 YYYY-MM-DD
  slug: string;                  // URL-safe 标识
  userRequest: string;           // 用户原始请求
  toolsUsed: Record<string, number>;  // 使用的工具统计
  summary: string;               // 记忆摘要
  scope?: MemoryScope;           // 作用域
  kind?: MemoryKind;             // 类型
  embedding?: number[];          // 向量嵌入（用于相似度计算）
  importance?: number;           // 重要度 1-5
  tags?: string[];               // 标签
  accessCount?: number;          // 访问次数
  updatedAt?: string;            // 最后更新时间
  expiresAt?: string;            // 过期时间
  validFrom?: string;            // 生效时间
  pinned?: boolean;              // 是否置顶
  facts?: StructuredFact[];      // 结构化事实
  supersedes?: string[];         // 被此记忆替代的旧记忆 slug
  sceneId?: string;              // 所属场景 ID
}

export interface MemoryScene {
  id: string;
  centroid: number[];      // 场景中心向量
  entries: string[];       // 包含的记忆 slug
  summary: string;         // 场景摘要
  tags: string[];          // 场景标签
  updatedAt: string;
  createdAt: string;
}
```

---

## 存储结构

```
.suncode/memories/
├── project/                    ← 项目级记忆
│   ├── MEMORY.md               ← 合并索引（供 LLM 阅读）
│   ├── MEMORY.json             ← JSON 索引（供检索）
│   ├── scenes/                 ← 场景聚类
│   │   └── scene-{id}.json
│   └── {date}-{slug}.md        ← 单条记忆
│       └── 格式：YAML frontmatter + Markdown 内容
└── session/{sessionId}/        ← 会话级记忆
    ├── MEMORY.md
    ├── MEMORY.json
    ├── scenes/
    └── {date}-{slug}.md
```

### 单条记忆文件格式

```yaml
---
date: "2026-07-11"
slug: "manual-1718078400000"
kind: "project_fact"
scope: "project"
importance: 3
tags: ["Vue", "component"]
updatedAt: "2026-07-11T10:00:00Z"
validFrom: "2026-07-11"
---

用户请求：创建一个记忆管理组件

记忆摘要：用户希望能够手动添加项目记忆，用于在后续会话中被 AI 引用。

---

## 结构化事实

- **事实**: 项目使用 Vue 3 框架
- **偏好**: 用户喜欢简洁的 UI 设计
- **决策**: 使用组件化架构

---

## 工具使用

- read: 1 次
- edit: 2 次
```

---

## 检索机制

### 混合评分算法

记忆检索采用混合评分机制，综合考虑以下因素：

```typescript
function hybridScore(entry: MemoryEntry, query: string, queryEmbedding: number[]): number {
  let score = 0;
  
  // 1. 关键词匹配（0-5分）
  const haystack = `${entry.userRequest} ${entry.summary} ${(entry.tags ?? []).join(' ')}`.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (fullQuery && haystack.includes(fullQuery)) score += 5;
  for (const term of terms) {
    if (haystack.includes(term)) score += 2;
  }
  
  // 2. 向量相似度（0-10分）
  if (entry.embedding && queryEmbedding.length > 0) {
    const similarity = cosineSimilarity(entry.embedding, queryEmbedding);
    score += similarity * 10;
  }
  
  // 3. 重要度（0-1.25分）
  score += (entry.importance ?? 1) * 0.25;
  
  // 4. 访问频率（0-1分）
  score += Math.min(entry.accessCount ?? 0, 10) * 0.1;
  
  // 5. 置顶权重（+1分）
  if (entry.pinned) score += 1;
  
  // 6. 时间有效性（0.3x 惩罚）
  const now = Date.now();
  const validFrom = entry.validFrom ? Date.parse(entry.validFrom) : -Infinity;
  const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : Infinity;
  if (now < validFrom || now > expiresAt) {
    score *= 0.3;
  }
  
  return score;
}
```

### 检索流程

```
用户请求
    │
    ▼
loadMemoriesWithEntries(workingDir, query, sessionId)
    │
    ├── 加载项目级记忆（project/）
    └── 加载会话级记忆（session/{sessionId}/）
    │
    ▼
searchMemories(entries, query)
    │
    ├── 计算关键词匹配得分
    ├── 计算向量相似度得分
    ├── 应用重要度、访问频率、置顶权重
    └── 检查时间有效性
    │
    ▼
按得分降序排列，取前 MAX_RETRIEVED_MEMORIES（默认5条）
    │
    ▼
返回 { content: MEMORY.md 内容, entries: MemoryEntry[] }
```

---

## 场景聚类

场景聚类自动将相似的记忆条目归组，形成更高层次的知识结构。

```typescript
// 聚类流程
for (const entry of entries) {
  // 1. 计算与现有场景的相似度
  for (const scene of existingScenes) {
    const similarity = cosineSimilarity(entry.embedding!, scene.centroid);
    if (similarity >= MEMSCENE_SIMILARITY_THRESHOLD) {
      // 2. 匹配到场景：更新场景中心和标签
      scene.entries.push(entry.slug);
      scene.centroid = updateCentroid(scene.centroid, entry.embedding!);
      scene.tags = [...new Set([...scene.tags, ...(entry.tags || [])])];
    }
  }
  
  // 3. 未匹配到场景：创建新场景
  if (!matchedScene) {
    const newScene: MemoryScene = {
      id: `scene-${Date.now()}`,
      centroid: [...entry.embedding!],
      entries: [entry.slug],
      summary: entry.summary || '',
      tags: entry.tags || [],
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    updatedScenes.push(newScene);
  }
}
```

**阈值配置：**
- `MEMSCENE_SIMILARITY_THRESHOLD`: 0.6（余弦相似度）
- `MEMSCENE_MIN_ENTRIES`: 2（最小条目数）

---

## 用户交互

### 1. 设置面板 - 记忆管理

设置面板新增"记忆管理"页面，提供以下功能：

| 功能 | 说明 |
|------|------|
| 添加记忆 | 填写内容、摘要、类型、重要度、标签 |
| 搜索记忆 | 按内容、摘要、标签搜索 |
| 查看详情 | 点击记忆条目打开详情弹窗 |
| 删除记忆 | 在详情弹窗中删除 |

```typescript
// SettingsPanel.vue
const newMemory = ref({
  userRequest: '',
  summary: '',
  kind: 'task_summary' as MemoryKind,
  scope: 'project' as MemoryScope,
  importance: 1,
  tags: '',
});

async function handleAddMemory() {
  const memory: MemoryEntry = {
    date: new Date().toISOString().slice(0, 10),
    slug: `manual-${Date.now()}`,
    userRequest: newMemory.value.userRequest,
    toolsUsed: {},
    summary: newMemory.value.summary,
    kind: newMemory.value.kind,
    scope: newMemory.value.scope,
    importance: newMemory.value.importance,
    tags: newMemory.value.tags.split(',').map(t => t.trim()).filter(Boolean),
  };
  await bridge.saveMemory(workingDir, memory);
}
```

### 2. 聊天消息 - 记忆引用展示

当 AI 回复使用了记忆时，在消息下方展示引用区域：

```
┌─────────────────────────────────────────────────────┐
│ AI 回复内容...                                      │
│                                                     │
│ 🧠 引用的记忆                                       │
│ ├── [项目事实] Vue 3 组件架构设计 (2026-07-11)      │
│ └── [决策] 使用 TypeScript strict 模式 (2026-07-10) │
│                                                     │
│ 10:00  [复制]                                       │
└─────────────────────────────────────────────────────┘
```

### 3. 记忆详情弹窗

点击记忆引用打开详情弹窗，显示完整信息：

| 信息项 | 说明 |
|--------|------|
| 类型标签 | 显示记忆类型（颜色区分） |
| 摘要 | 记忆的简要描述 |
| 内容 | 用户原始请求 |
| 结构化事实 | 提取的事实、偏好、决策 |
| 标签 | 关联标签 |
| 工具使用 | 使用的工具统计 |
| 元数据 | 创建时间、访问次数、重要度 |

---

## IPC 接口

### 前端 API（bridge.ts）

```typescript
interface MemoryApi {
  // 获取所有记忆
  getMemories(workingDir?: string, sessionId?: string): Promise<MemoryEntry[]>;
  
  // 保存记忆
  saveMemory(
    workingDir: string,
    memory: MemoryEntry,
    sessionId?: string,
  ): Promise<void>;
  
  // 删除记忆
  deleteMemory(workingDir: string, date: string, slug: string, sessionId?: string): Promise<void>;
  
  // 搜索记忆
  searchMemories(workingDir: string, query: string, sessionId?: string): Promise<MemoryEntry[]>;
  
  // 获取记忆详情
  getMemoryDetail(workingDir: string, date: string, slug: string, sessionId?: string): Promise<MemoryEntry | null>;
  
  // 获取记忆场景
  getMemoryScenes(workingDir?: string, sessionId?: string): Promise<MemoryScene[]>;
}
```

### IPC 通道

| 通道名 | 方向 | 说明 |
|--------|------|------|
| `memory:get` | Renderer → Main | 获取记忆列表 |
| `memory:save` | Renderer → Main | 保存记忆 |
| `memory:delete` | Renderer → Main | 删除记忆 |
| `memory:search` | Renderer → Main | 搜索记忆 |
| `memory:getDetail` | Renderer → Main | 获取记忆详情 |
| `memory:getScenes` | Renderer → Main | 获取场景列表 |

---

## 数据流

### 自动记忆记录流程

```
用户发送请求
    │
    ▼
Agent.prompt()
    │
    ├── loadMemoriesWithEntries() 加载现有记忆
    │       │
    │       ├── 项目级记忆
    │       └── 会话级记忆
    │       │
    │       ▼
    │   searchMemories() 按查询匹配
    │       │
    │       ▼
    │   返回 { content, entries }
    │       │
    │       ├── content → 注入 system prompt
    │       └── entries → 传递给 agent-loop
    │
    ▼
runAgentLoop()
    │
    │  ...执行任务...
    │
    ▼
message_end 事件
    │
    └── memoryReferences: input.memoryEntries  ← 传递记忆条目
        │
        ▼
ChatStore.handleStreamEvent()
        │
        └── target.memoryReferences = data.memoryReferences
            │
            ▼
AssistantMessage 渲染记忆引用
```

### 用户手动添加记忆流程

```
用户在设置面板填写记忆
    │
    ▼
bridge.saveMemory(workingDir, memory)
    │
    ▼
preload.ts → ipcRenderer.invoke('memory:save', ...)
    │
    ▼
ipc-handlers.ts → saveMemory(workingDir, entry)
    │
    ▼
memory.ts → writeFileSync({date}-{slug}.md)
    │
    ▼
rebuildIndexes() 更新 MEMORY.md / MEMORY.json
```

---

## 关键约束

1. **最大检索数量** — `MAX_RETRIEVED_MEMORIES = 5`，避免过多记忆占用 context
2. **记忆大小限制** — `MAX_SUMMARY_LENGTH = 500`，摘要不超过 500 字符
3. **存储上限** — `MAX_FILES = 30`，单个作用域最多 30 个记忆文件（通过合并机制扩展）
4. **过期记忆降权** — 不在有效期内的记忆得分乘以 0.3
5. **置顶优先** — 置顶记忆额外加 1 分
6. **向量嵌入缓存** — `embeddingCache` 避免重复计算

---

## 文件清单

```
src/
├── shared/
│   └── types.ts              ← MemoryScope, MemoryKind, MemoryEntry, StructuredFact
├── worker/
│   └── agent/
│       ├── memory.ts          ← 🎯 记忆核心模块
│       │   ├── loadMemories()
│       │   ├── loadMemoriesWithEntries()
│       │   ├── saveMemory()
│       │   ├── deleteMemory()
│       │   ├── searchMemories()
│       │   ├── consolidateMemories()
│       │   └── consolidateMemScenes()
│       ├── agent.ts           ← 加载记忆并传递给 agent-loop
│       └── agent-loop.ts      ← 消息结束时传递 memoryEntries
├── main/
│   ├── preload.ts             ← IPC API 定义
│   └── ipc-handlers.ts        ← IPC 处理器
└── renderer/
    ├── api/
    │   └── bridge.ts          ← 前端 API 封装
    ├── types/
    │   └── ipc.ts             ← Window.suncode 类型声明
    ├── stores/
    │   └── chat.ts            ← ChatMessage.memoryReferences
    └── components/
        ├── chat/
        │   ├── AssistantMessage.vue  ← 记忆引用展示
        │   ├── MemoryReference.vue   ← 记忆引用组件
        │   └── MemoryDetail.vue      ← 记忆详情弹窗
        └── settings/
            └── SettingsPanel.vue     ← 记忆管理页面
```

---

## 对比与参考

### 与 mem0 的对比

| 特性 | SunCode | mem0 |
|------|---------|------|
| 存储方式 | 文件系统（.md） | 向量数据库 |
| 检索方式 | 混合（关键词+向量） | 纯向量 |
| 结构化事实 | 支持 | 不支持 |
| 时间有效性 | 支持 | 不支持 |
| 场景聚类 | 支持 | 不支持 |
| 用户手动添加 | 支持 | 不支持 |
| 聊天中展示引用 | 支持 | 不支持 |

### 与 EverOS 的对比

| 特性 | SunCode | EverOS |
|------|---------|--------|
| 架构 | 本地文件系统 | 分布式 graph |
| 多模态支持 | 文本为主 | 支持图像/视频 |
| 实时协作 | 不支持 | 支持 |
| 知识图谱 | 场景聚类 | 完整 graph |
| 部署方式 | 桌面应用 | 云服务 |

---

## 当前实现限制与未来改进

### 当前限制

1. **向量嵌入** — 当前使用 `simpleTextEmbedding` 作为轻量级 fallback（基于词频统计），未集成 pi-ai 的 embed 功能，检索准确性有限。`embeddingCache` 用于缓存嵌入结果避免重复计算。

### 未来改进

1. **增强向量嵌入** — 集成 pi-ai 的 embed 功能，提升检索准确性
2. **跨项目记忆共享** — 支持用户级全局记忆
3. **记忆版本管理** — 追踪记忆的变更历史
4. **记忆导出/导入** — 支持备份和迁移
5. **智能推荐** — 根据上下文自动推荐相关记忆
