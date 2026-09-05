# 记忆系统设计文档

日期: 2026-08-09 | 状态: 已实现

---

## 概述

SunCode 的记忆系统旨在帮助 AI agent 持久化和复用重要信息。系统采用关键词匹配 + 本地稀疏文本特征相似度检索，支持结构化事实提取、明确记忆意图升级、时间有效性管理、场景聚类、常驻通道、LLM 语义相关性精排和用户编辑。

**核心原则：**

- **双向记忆**：自动记录（会话总结）+ 手动添加（用户输入）
- **分级持久化**：普通摘要保留在会话级；明确要求长期记忆且高置信度的事实、决策和偏好升级到项目级或全局级
- **来源标注**：每条记忆标注 `origin`（自动记录 / 主动请求升级 / 手动添加），UI 以徽章区分
- **时间感知**：支持记忆的有效期管理
- **场景聚类**：相似记忆自动归组（与检索同特征空间的稀疏余弦）
- **透明可见**：用户可查看、搜索、删除记忆
- **检索增强**：聊天中展示引用的记忆，点击可查看详情；引用随消息持久化，重启后仍可见

---

## 架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          用户界面层                                      │
│  ┌───────────────┐    ┌───────────────┐    ┌─────────────────────┐     │
│  │ 设置 - 记忆   │    │ 聊天 - 引用    │    │ 记忆详情弹窗        │     │
│  │ · 添加记忆    │    │ · 显示引用     │    │ · 来源徽章          │     │
│  │ · 搜索记忆    │    │ · 点击查看     │    │ · 完整信息          │     │
│  │ · 删除记忆    │    │ · 详情弹窗     │    │ · 结构化事实        │     │
│  └───────────────┘    └───────────────┘    └─────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ IPC
┌─────────────────────────────────────────────────────────────────────────┐
│                          主进程层                                        │
│  preload.ts  ← IPC API 桥接                                              │
│  ipc-handlers.ts  ← 记忆操作处理器 + 一次性迁移（legacy → 新布局）        │
│  index.ts  ← 启动时设置 SUNCODE_APP_DATA、迁移 flat 记忆                  │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ postMessage
┌─────────────────────────────────────────────────────────────────────────┐
│                          Worker 层                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                        记忆核心模块                                   │ │
│  │  memory.ts                                                           │ │
│  │  ├── 存储管理   → {appData}/global|projects/{hash}|sessions/...      │ │
│  │  ├── 索引管理   → MEMORY.md / MEMORY.json                            │ │
│  │  ├── 场景聚类   → scenes/{sceneId}.json（稀疏特征质心）               │ │
│  │  ├── 混合检索   → 关键词 + 稀疏余弦 + 常驻通道 + 主题门控             │ │
│  │  ├── 语义精排   → LLM relevance judge（失败回退启发式）               │ │
│  │  ├── 事实提取   → LLM 提取结构化事实                                   │ │
│  │  └── 迁移        → flat 记忆 / 旧路径 hash → 统一布局                 │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                        Agent 集成                                    │ │
│  │  agent.ts  → loadMemoriesWithEntries() + relevanceJudge              │ │
│  │  agent.ts  → saveSessionMemory() / promoteExplicitDurableFacts()     │ │
│  │  agent-loop.ts  → 检索内容进入 runtime_context                      │ │
│  │  subagent.ts    → 主 Agent 将同一份检索结果传给 Subagent            │ │
│  │  agent-loop.ts  → memoryReferences 随 finalMessage 持久化            │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 数据模型

### 核心类型

```typescript
// shared/types.ts

export type MemoryScope = 'session' | 'project' | 'global';
export type MemoryKind =
  | 'task_summary'    // 任务摘要（自动）
  | 'project_fact'    // 项目事实（手动/自动）
  | 'decision'        // 决策（手动/自动）
  | 'preference'      // 用户偏好（手动/自动）
  | 'lesson'          // 经验教训（自动）
  | 'ephemeral';      // 临时记忆（自动）
export type MemoryOrigin = 'auto' | 'explicit' | 'manual';
//  auto     → 会话结束自动记录（saveSessionMemory）
//  explicit → 用户明确要求长期记忆，promoteExplicitDurableFacts 升级的持久条目
//  manual   → 用户在设置面板手动添加

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
  origin?: MemoryOrigin;         // 来源（auto/explicit/manual），UI 徽章
  importance?: number;           // 重要度 1-5
  tags?: string[];               // 标签
  accessCount?: number;          // 访问次数（检索路径只累加内存计数，写操作时才落盘）
  updatedAt?: string;            // 最后更新时间
  expiresAt?: string;            // 过期时间
  validFrom?: string;            // 生效时间
  pinned?: boolean;              // 是否置顶
  facts?: StructuredFact[];      // 结构化事实
  supersedes?: string[];         // 被此记忆替代的旧记忆 slug（矛盾事实取代链）
  sceneId?: string;              // 所属场景 ID
}

export interface MemoryScene {
  id: string;
  features: Record<string, number>;  // 稀疏特征 → 权重质心（与 textFeatureMap 同特征空间）
  entryCount: number;          // 已并入质心的条目数（用于加权更新）
  entries: string[];           // 包含的记忆 slug
  summary: string;             // 场景摘要
  tags: string[];              // 场景标签
  updatedAt: string;
  createdAt: string;
}
```

---

## 存储结构

主进程启动时设置 `SUNCODE_APP_DATA` 环境变量并显式传给 Worker（IPC 处理器与 Worker 解析同一份路径），数据统一落在 app data 下：

```
{appData}/                               ← 由 paths.ts 的 getAppDataDir() 解析
├── global/
│   └── memories/                        ← 全局级记忆（跨项目）
│       ├── MEMORY.md / MEMORY.json      ← 索引
│       ├── scenes/                      ← 场景聚类
│       └── {date}-{slug}.md             ← 单条记忆
├── projects/
│   └── {sha256(规范化工作目录)[0:16]}/
│       └── memories/                    ← 项目级记忆
└── sessions/
    └── {sessionId}/
        ├── .suncode/memories/           ← 会话级记忆（含索引与 scenes/）
        ├── snapshot.json                ← 会话快照
        └── .suncode/...                 ← plans / tool-result-archive / turn-evidence 等
```

- **路径哈希**：工作目录先规范化分隔符（Windows `\` → `/`）再哈希，同一项目以不同分隔符风格打开共享同一记忆目录。
- **旧布局兼容**：无 `SUNCODE_APP_DATA` 时回退到 `workingDir/.suncode/memories/{session|project}` 与 `~/.suncode/global/memories`（无头模式等）。项目级读取同时扫描规范化路径与 legacy 路径（按 date-slug 去重，规范化路径优先）。

### 一次性迁移

| 迁移 | 触发点 | 行为 |
|------|--------|------|
| `migrateLegacyFlatMemories` | 主进程启动（index.ts） | `appData/memories/{date}-{slug}.md`（作用域布局前的扁平记忆）→ global scope；幂等，目标已存在则跳过，目录清空后移除旧索引 |
| `migrateLegacyProjectMemories` | `memory:get` / `memory:save` | legacy 未规范化路径哈希目录 → 规范化哈希目录；合并去重（已存在保留），src 移除 |

### 单条记忆文件格式

frontmatter 中的 `meta` 行是机器读取的唯一真源（完整 JSON，无损往返）；
其余字段和 Markdown 正文仅供人阅读。旧格式文件（无 `meta` 行）仍按正文小节解析。

```yaml
---
meta: {"date":"2026-07-11","slug":"manual-1718078400000","kind":"project_fact","origin":"manual",...}
date: "2026-07-11"
scope: "project"
kind: "project_fact"
origin: "manual"
importance: 3
tags: ["Vue", "component"]
---

## 创建一个记忆管理组件

**工具使用**:
  - read x1

**摘要**:
用户希望能够手动添加项目记忆，用于在后续会话中被 AI 引用。

**结构化事实**:
- fact: 项目 使用 Vue 3

**取代的记忆**:
- durable-preference-用户-喜欢-gh-cli
```

---

## 检索机制

### 检索流程

```
用户请求
    │
    ▼
loadMemoriesWithEntries(workingDir, query, sessionId, { relevanceJudge })
    │
    ├── 加载全部记忆（global + project + session）
    ├── isSocialQuery(query)？→ 问候/闲聊/心情 → 跳过检索，返回空
    │
    ▼
常驻通道（resident channel）
    ├── pinned / global / preference 记忆为候选
    ├── 每个候选必须通过主题门控（hybridScore ≥ 2.0）
    └── 按重要度、更新时间排序，取前 MAX_RESIDENT_MEMORIES（2 条）
    │
    ▼
普通检索（剩余条目）
    ├── hybridScore ≥ MIN_RELEVANCE_SCORE（2.0）才入选
    └── 按得分降序取前 MAX_RETRIEVED_MEMORIES（5 条）
    │
    ▼
LLM 语义精排（可选）
    ├── 候选池 = 常驻 + 普通检索 + 近漏补充（得分 ≥ 0.3，补齐至 8 个）
    ├── judge 逐条判断主题相关性，丢弃误入选、捞回漏选
    └── judge 不可用/调用失败/解析失败 → 回退启发式结果
    │
    ▼
同源合并（相同 userRequest 折叠为一条，事实合并）
    │
    ▼
记录访问（仅内存计数，写时落盘）
    │
    ▼
返回 { content: 注入 runtime_context, entries: 引用展示 }
```

### 混合评分算法

```typescript
function hybridScore(entry: MemoryEntry, query: string, queryFeatures: Map<string, number>): number {
  // 纯相关性得分：只反映查询与记忆的真实重叠
  let relevanceScore = 0;
  const haystack = `${userRequest} ${summary} ${tags} ${facts}`.toLowerCase();

  // 1. 关键词匹配
  if (haystack.includes(fullQuery)) relevanceScore += 5;   // 完整查询
  for (const term of terms) {
    if (haystack.includes(term)) relevanceScore += 2;      // 词项
  }
  // 中文单 token：字符二元组匹配（如 "改一下" 命中含 "改一" 的记忆）
  if (terms.length === 1 && /[\u4e00-\u9fff]/.test(terms[0])) {
    for (const bigram of chars(terms[0])) {
      if (haystack.includes(bigram)) relevanceScore += 1;
    }
  }

  // 2. 反向标签匹配：标签（或其字母数字 token）出现在查询里即 +3
  //    ——标签是保存时的语义标签，能抓住词项匹配漏掉的场景
  //    （如标签 github-cli 命中查询 URL 里的 github）
  if (tagHitsQuery(entry, query)) relevanceScore += 3;

  // 3. 稀疏余弦相似度（×10）：key-aligned，无共享特征即为 0，
  //    无关文本不可能靠高维巧合越过阈值
  relevanceScore += sparseCosine(entryFeatures, queryFeatures) * 10;

  // 偏见加权（重要度/访问频率/置顶）只在纯相关性过阈后才生效：
  // 防止置顶/全局记忆靠偏见加权混进每个会话（如共享中文虚词 "的"）
  let score = relevanceScore;
  if (relevanceScore >= MIN_RELEVANCE_SCORE) {
    score += (entry.importance ?? 1) * 0.25;          // 重要度 0-1.25
    score += Math.min(entry.accessCount ?? 0, 10) * 0.1;  // 访问频率 0-1
    if (entry.pinned) score += 1;                     // 置顶 +1
  }

  // 4. 时间有效性（0.3x 惩罚）
  if (!isCurrentlyValid(entry)) score *= 0.3;

  return score;
}
```

### 常驻通道与主题门控

- **常驻候选**：`pinned`、`scope === 'global'`、`kind === 'preference'` 三类记忆不依赖关键词重叠就有注入价值，先于普通检索进入候选。
- **主题门控**：任何常驻候选（置顶也不例外）必须通过 `hybridScore ≥ 2.0` 才注入，避免无关偏好/置顶记忆挤进每个会话（例如测试评审时注入 GitHub CLI 偏好）。无查询时（非检索场景）保持原行为放行。
- 常驻通道上限 `MAX_RESIDENT_MEMORIES = 2`，与普通检索结果合并后总计仍受 `MAX_RETRIEVED_MEMORIES = 5` 约束。

### LLM 语义相关性精排

启发式（关键词 + 稀疏余弦）对"共享常见词但主题无关"的误选无能为力，因此用模型做二次判断：

- 候选池上限 `JUDGE_CANDIDATE_LIMIT = 8`：启发式命中 + 近漏补充（`hybridScore ≥ JUDGE_RECALL_FLOOR = 0.3` 但未达 2.0 阈值的记忆，按得分补齐候选池），让 judge 有机会捞回启发式误排的记忆（如标签命中的 URL 查询）。
- judge 返回相关条目编号，只保留被判定相关的记忆（置顶记忆同样接受主题判断）。
- judge 不可用、调用失败、返回无法解析 → 返回 `null`，回退启发式结果，不阻塞检索。

### 社交查询跳过

`isSocialQuery` 识别问候（你好/早上好）、身份/能力闲聊（你是谁）、心情表达、笑声等，直接跳过记忆检索与自动记录——这类查询没有任务上下文，注入记忆是噪音。含文件路径、代码符号、CLI 标志的查询（`/\\:<>{}[]()=+*|&^%$#@!~`` 等）始终允许检索。

### 同源合并

一条用户请求可能产生多条结构相同（不同 kind 或重复保存）的记忆，检索时按 `userRequest` 折叠为一条：

- 以"最强"条目为壳（重要度优先 → kind 优先级 `preference > decision > project_fact > task_summary` → 更新时间最新）
- facts 按 `type|subject|predicate|object` 去重合并，tags 合并，accessCount 求和
- 壳条目的 pinned / scope / kind / slug 保留，引用键稳定

---

## 场景聚类

场景聚类自动将相似的记忆条目归组，与检索共用同一特征空间（key-aligned 稀疏余弦），质心语义与检索一致。

```typescript
// 增量路径（每次保存时）：只把新条目折入现有场景
function consolidateMemScenes(memDir, newEntry) {
  const { scenes, legacy } = loadMemScenes(memDir);
  if (newEntry && !legacy) {
    const features = entryFeatures(newEntry);
    const matched = findBestScene(scenes, features);  // 稀疏余弦 ≥ 阈值
    const scene = matched ?? newSceneFromEntry(newEntry, features);
    if (matched) foldEntryIntoScene(scene, newEntry, features);  // 加权质心
    writeSceneFile(memDir, scene);
    writeEntrySceneId(memDir, newEntry, scene.id);
    return;
  }
  // 全量重建（旧格式场景文件触发）：重聚类全部条目
}

// 质心更新：加权折叠
foldEntryIntoScene(scene, entry, features) {
  merged = scene.features * scene.entryCount + features;  // 旧质心 × 旧计数
  scene.features = merged / (scene.entryCount + 1);        // 新质心
  scene.entryCount += 1;
  scene.tags ∪= entry.tags;
  scene.summary = mergeSummaries(scene.summary, entry.summary);
}
```

**阈值配置：**
- `MEMSCENE_SIMILARITY_THRESHOLD`: 0.2（稀疏余弦，短文本相关度天然低于旧位置余弦）
- `MEMSCENE_MIN_ENTRIES`: 2（最小条目数）

**旧格式迁移**：场景文件带位置型 `centroid: number[]`（旧格式）或缺失 `features` 时标记为 legacy，下次 consolidate 触发全量重建，增量路径自动失效。

---

## 用户交互

### 1. 设置面板 - 记忆管理

设置面板新增"记忆管理"页面，提供以下功能：

| 功能 | 说明 |
|------|------|
| 添加记忆 | 填写内容、摘要、类型、重要度、标签（自动标注 `origin: manual`） |
| 搜索记忆 | 按内容、摘要、标签搜索（走 `searchMemories` 混合评分） |
| 查看详情 | 点击记忆条目打开详情弹窗（含来源徽章、取代链） |
| 删除记忆 | 在详情弹窗中删除 |

设置面板与添加弹窗使用**当前活动会话的 workingDirectory**（而非应用 cwd），保证读写的项目记忆一致。

### 2. 聊天消息 - 记忆引用展示

当 AI 回复使用了记忆时，在消息下方展示引用区域。引用通过 `memoryReferences` 随消息持久化（`Message` 类型字段 + agent-loop `finalMessage` 传递 + chat store 保存/恢复），切换会话或重启应用后仍可见：

```
┌─────────────────────────────────────────────────────┐
│ AI 回复内容...                                      │
│                                                     │
│ 🧠 引用的记忆                                       │
│ ├── [主动][偏好] 用户 喜欢 gh CLI (2026-08-09)      │
│ ├── [自动][项目事实] Vue 3 组件架构设计 (2026-07-11) │
│ └── [手动][决策] 使用 TypeScript strict (2026-07-10) │
│                                                     │
│ 10:00  [复制]                                       │
└─────────────────────────────────────────────────────┘
```

来源徽章配色：自动 = 弱化色，主动 = 橙色，手动 = 绿色。

### 3. 记忆详情弹窗

点击记忆引用打开详情弹窗，显示完整信息：

| 信息项 | 说明 |
|--------|------|
| 类型标签 | 显示记忆类型（颜色区分） |
| 来源徽章 | auto（自动）/ explicit（主动）/ manual（手动） |
| 摘要 | 记忆的简要描述 |
| 内容 | 用户原始请求 |
| 结构化事实 | 提取的事实、偏好、决策 |
| 标签 | 关联标签 |
| 工具使用 | 使用的工具统计 |
| 元数据 | 创建时间、访问次数、重要度、取代链 |

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

  // 更新记忆，可修改字段或迁移作用域
  updateMemory(workingDir: string, date: string, slug: string, updates: Partial<MemoryEntry>, sessionId?: string): Promise<void>;
  
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
| `memory:get` | Renderer → Main | 获取记忆列表（含 legacy 项目迁移触发） |
| `memory:save` | Renderer → Main | 保存记忆（自动补 `origin: manual`；含迁移触发） |
| `memory:update` | Renderer → Main | 更新或迁移记忆 |
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
    ├── recentUserText() 拼接最近 3 条用户消息作为检索查询
    │       （代词后续 "继续改一下" 也能匹配早期记忆）
    ├── loadMemoriesWithEntries(query, { relevanceJudge })
    │       ├── 常驻通道（主题门控）→ 普通检索 → LLM 精排 → 同源合并
    │       └── 返回 { content, entries }
    │           ├── content → 注入 runtime_context.snapshot.memory
    │           └── entries → recordMemoryAccess()（内存计数）+ 传递 UI
    │
    ▼
runAgentLoop()
    │
    │  ...执行任务...
    │
    ▼
Agent.saveSessionMemory()
    ├── isMemoryWorthSaving()？        ← 社交查询不记录；零工具且 <20 字符不记录
    ├── isExplicitDurableMemoryRequest()？ ← 明确记忆请求总是记录
    ├── saveMemory() 写入会话级记忆（origin: auto）
    │       ├── generateSummary() / extractStructuredFacts()（LLM）
    │       ├── consolidateMemScenes() 增量折入场景
    │       ├── pruneOldMemories() 按保留分裁剪超 30 条
    │       └── flushMemoryAccessCounts() 落盘访问计数
    └── promoteExplicitDurableFacts()  ← 明确请求时升级持久记忆
            ├── 置信度 ≥ 0.8 的 fact/preference/decision 提取
            ├── 一次请求产生一条记忆：所有类型事实合并存储
            │       （含 preference → global，否则 project）
            ├── 幂等：全部事实已存在则跳过（稳定 slug 保证重复运行不重复写）
            ├── 矛盾处理：同 stem 不同 object 视为矛盾，只移除矛盾事实；
            │       整条全被取代才删除，记录 supersedes 链
            └── origin: explicit，kind 取 preference > decision > project_fact
    │
    ▼
message_end 事件
    ├── runtime_context: memoryContent（主 Agent 与 Subagent 共用）
    └── memoryReferences: input.memoryEntries
        │
        ▼
agent-loop finalMessage → ChatStore（持久化到 Message）
        │
        ▼
AssistantMessage 渲染记忆引用（重启后仍可见）
```

### 用户手动添加记忆流程

```
用户在设置面板填写记忆
    │
    ▼
bridge.saveMemory(workingDir, memory)     ← origin: 'manual'
    │
    ▼
preload.ts → ipcRenderer.invoke('memory:save', ...)
    │
    ▼
ipc-handlers.ts → migrateLegacyProjectMemories() + saveMemory()
    │
    ▼
memory.ts → writeFileSync({date}-{slug}.md)
    │
    ├── 增量场景分配
    ├── 访问计数落盘
    └── rebuildIndexes() 更新 MEMORY.md / MEMORY.json
```

### 访问计数

- **读路径只读**：`recordMemoryAccess` 只累加内存 `pendingAccessCounts`，不写盘。
- **落盘时机**：任何记忆写操作（`saveMemory` / `flushMemoryAccessCounts` 显式调用）+ run / continue / runStopSummary 结束时统一 flush，保证只读会话的计数也能持久化。

---

## 关键约束

1. **最大检索数量** — `MAX_RETRIEVED_MEMORIES = 5`，避免过多记忆占用 context
2. **常驻通道上限** — `MAX_RESIDENT_MEMORIES = 2`，pinned/global/preference 注入候选
3. **语义精排候选池** — `JUDGE_CANDIDATE_LIMIT = 8`，近漏召回下限 `JUDGE_RECALL_FLOOR = 0.3`
4. **最低相关性阈值** — `MIN_RELEVANCE_SCORE = 2.0`，低于阈值不入选，偏见加权不可越阈
5. **记忆大小限制** — `MAX_SUMMARY_LENGTH = 500`，摘要不超过 500 字符
6. **存储上限** — `MAX_FILES = 30`，单个作用域最多 30 个记忆文件（按保留分裁剪）
7. **过期记忆降权** — 不在有效期内的记忆得分乘以 0.3
8. **置顶优先** — 置顶记忆额外加 1 分（仍须过主题门控）
9. **偏见加权** — 重要度/访问频率/置顶只在纯相关性 ≥ 2.0 后生效，防止无关记忆靠加权注入
10. **路径规范化** — 工作目录分隔符规范化后再哈希，Windows `\` 与 `/` 共享同一项目记忆目录

---

## 文件清单

```
src/
├── shared/
│   └── types.ts              ← MemoryScope, MemoryKind, MemoryOrigin, MemoryEntry, StructuredFact, Message.memoryReferences
├── worker/
│   └── agent/
│       ├── memory.ts          ← 🎯 记忆核心模块
│       │   ├── loadMemories() / loadMemoriesWithEntries()
│       │   ├── saveMemory() / updateMemory() / deleteMemory()
│       │   ├── searchMemories() / hybridScore() / tagHitsQuery()
│       │   ├── isSocialQuery() / isMemoryWorthSaving()
│       │   ├── createLLMRelevanceJudge()  ← LLM 语义精排
│       │   ├── mergeSameSourceEntries() / mergeMemories()
│       │   ├── consolidateMemScenes() / sparseCosine() / textFeatureMap()
│       │   ├── recordMemoryAccess() / flushMemoryAccessCounts()
│       │   ├── migrateLegacyFlatMemories() / migrateLegacyProjectMemories()
│       │   ├── saveSessionSnapshot() / loadSessionSnapshot() / buildSessionSnapshot()
│       │   └── getAllMemories() / getMemScenes()
│       ├── agent-data-dir.ts  ← SUNCODE_APP_DATA 路径统一解析
│       ├── agent.ts           ← 记忆加载、saveSessionMemory、promoteExplicitDurableFacts
│       ├── runtime-context.ts ← memory / lessons / language 运行时快照
│       ├── subagent.ts        ← 继承主 Agent 检索结果
│       └── agent-loop.ts      ← 注入 runtime_context；finalMessage 携带引用
├── main/
│   ├── index.ts               ← 设置 SUNCODE_APP_DATA、flat 记忆迁移
│   ├── preload.ts             ← IPC API 定义
│   └── ipc-handlers.ts        ← IPC 处理器、项目记忆迁移
└── renderer/
    ├── api/
    │   └── bridge.ts          ← 前端 API 封装
    ├── stores/
    │   └── chat.ts            ← Message.memoryReferences 持久化/恢复
    └── components/
        ├── chat/
        │   ├── AssistantMessage.vue  ← 记忆引用展示
        │   ├── MemoryReference.vue   ← 记忆引用组件（来源徽章）
        │   ├── MemoryDetail.vue      ← 记忆详情弹窗（来源徽章）
        │   └── MemoryAddDialog.vue   ← 添加记忆（origin: manual）
        └── settings/
            └── SettingsPanel.vue     ← 记忆管理页面
```

---

## 对比与参考

### 与 mem0 的对比

| 特性 | SunCode | mem0 |
|------|---------|------|
| 存储方式 | 文件系统（.md + 稀疏特征） | 向量数据库 |
| 检索方式 | 混合（关键词 + 稀疏余弦 + LLM 精排） | 纯向量 |
| 结构化事实 | 支持 | 不支持 |
| 时间有效性 | 支持 | 不支持 |
| 场景聚类 | 支持（与检索同特征空间） | 不支持 |
| 用户手动添加 | 支持 | 不支持 |
| 聊天中展示引用 | 支持（持久化） | 不支持 |

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

1. **特征表示** — 使用 CJK n-gram + ASCII token 的稀疏词频特征（过滤停用虚词），未集成模型 embedding，长文本语义近似度有限；`sparseCosine` 保证无共享特征即 0，但也因此无法捕捉"换词同义"的语义关联。
2. **精排开销** — LLM 语义 judge 每轮检索至多一次 LLM 调用（15s 超时），失败时回退启发式，但成功路径增加延迟与 token 开销。
3. **场景聚类粒度** — 增量路径只对新条目就近折入，旧条目不重分配；仅在 legacy 场景文件存在时全量重建。

### 未来改进

1. **增强语义检索** — 集成模型 embedding 提升检索准确性
2. **跨项目记忆共享** — 支持用户级全局记忆（已具备 global scope，可扩展共享语义）
3. **记忆版本管理** — 追踪记忆的变更历史
4. **记忆导出/导入** — 支持备份和迁移
5. **智能推荐** — 根据上下文自动推荐相关记忆
