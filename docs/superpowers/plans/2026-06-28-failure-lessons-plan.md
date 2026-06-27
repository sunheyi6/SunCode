# 失败教训自动记录与检索系统 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在对话过程中自动提取失败教训，存储到 `.suncode/lessons/`，后续通过 `search_lessons` 工具按需检索。

**Architecture:** 四层结构 — 触发层（agent.ts run 结束后检测失败场景）→ 提取层（轻量 LLM 提炼结构化教训）→ 存储层（`.suncode/lessons/` 文件系统）→ 检索层（`search_lessons` 工具 + 工具结果自动增强）。

**Tech Stack:** TypeScript, Node.js fs/path, @earendil-works/pi-ai (轻量 LLM 调用), JSON/YAML frontmatter

**Spec:** `docs/superpowers/specs/2026-06-28-failure-lessons-design.md`

---

## 文件结构

| 操作 | 路径 | 职责 |
|------|------|------|
| Modify | `src/shared/types.ts` | 添加 `LessonTriggerType`, `LessonEntry`, `LessonIndex`, `LessonSearchResult`, `LessonExtractionContext` 类型；`AppSettings` 加 `maxLessons` |
| Modify | `src/shared/constants.ts` | 添加 `DEFAULT_MAX_LESSONS = 200` |
| Modify | `src/renderer/stores/settings.ts` | 默认值加 `maxLessons: 200` |
| Create | `src/worker/agent/lessons.ts` | 教训核心模块：存储、索引、检索、读取索引、保存教训、LLM 提取、去重、搜索 |
| Create | `src/worker/tools/search-lessons.ts` | `search_lessons` 工具实现（只读） |
| Modify | `src/worker/tools/registry.ts` | 注册 `search_lessons` 工具 |
| Modify | `src/worker/agent/agent.ts` | `runLoop()`/`runGoalLoop()` 后调用 `extractLessonsIfNeeded()` |
| Modify | `src/worker/agent/agent-loop.ts` | 工具执行失败时增强 `ToolResult.output` 追加匹配教训提示 |

---

### Task 1: 类型定义和常量

**Files:**

- Modify: `src/shared/types.ts` (在最终化类型附近添加类型，在 AppSettings 接口添加字段)
- Modify: `src/shared/constants.ts` (在常量区域添加)

- [ ] **Step 1: 在 shared/types.ts 添加教训相关类型**

在 `// ===== Subagent Types =====` 之前插入以下类型：

```typescript
// ===== Lesson Types =====

/** 教训触发类型 */
export type LessonTriggerType =
  | 'tool_failure'
  | 'user_correction'
  | 'run_error'
  | 'goal_repeated_failure';

/** 单条教训条目 */
export interface LessonEntry {
  /** 文件名中的 slug */
  slug: string;
  /** 触发类型 */
  type: LessonTriggerType;
  /** 涉及的工具名（无则为空字符串） */
  tool: string;
  /** 关键词 */
  keywords: string[];
  /** 相关文件路径 */
  files: string[];
  /** ISO 日期 (YYYY-MM-DD) */
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

/** 教训索引（LESSONS.md 的内存表示） */
export interface LessonIndex {
  /** 按日期倒序排列的条目 */
  entries: LessonEntry[];
  /** 最后更新时间 (ISO) */
  updatedAt: string;
}

/** 搜索结果 */
export interface LessonSearchResult {
  entry: LessonEntry;
  /** 匹配打分（关键词交集计数） */
  score: number;
}

/** 提取上下文（传入 extractLessonsIfNeeded 的原始材料） */
export interface LessonExtractionContext {
  triggerType: LessonTriggerType;
  /** 最近几轮消息（含工具调用和结果） */
  relevantMessages: Message[];
  /** 错误详情（可选） */
  error?: string;
  /** 关联的 runId */
  runId: string;
}
```

在 `AppSettings` 接口末尾（`envApiKeys` 之后、`goalMaxTurns` 之前）添加：

```typescript
  /** 最多保留的教训条数，默认 200 */
  maxLessons?: number;
```

- [ ] **Step 2: 在 shared/constants.ts 添加常量**

在 `// ===== Context Budget Defaults =====` 之前插入：

```typescript
/** 默认最大教训条数 */
export const DEFAULT_MAX_LESSONS = 200;
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 无类型错误（若已有预存错误则忽略，只看新增的）

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "feat(lessons): add LessonEntry, LessonIndex types and DEFAULT_MAX_LESSONS constant"
```

---

### Task 2: Settings 扩展

**Files:**

- Modify: `src/renderer/stores/settings.ts`

- [ ] **Step 1: 在 settings.ts 默认值添加 maxLessons**

在 `settings` ref 初始值中添加一行：

在 `envApiKeys: {},` 之后添加：

```typescript
    maxLessons: 200,
```

完整块（仅展示上下文，实际只加一行）：

```typescript
  const settings = ref<AppSettings>({
    activeModel: 'claude-sonnet-4-5',
    activeProvider: 'anthropic',
    thinkingLevel: 'low',
    maxTurns: 50,
    autoCompact: true,
    compactThreshold: 0.7,
    theme: 'system',
    permissionMode: 'full_access',
    fontSize: 14,
    mcpServers: [],
    skills: [],
    envApiKeys: {},
    maxLessons: 200,
  });
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/stores/settings.ts
git commit -m "feat(lessons): add maxLessons default to settings store"
```

---

### Task 3: 教训核心模块 (lessons.ts)

**Files:**

- Create: `src/worker/agent/lessons.ts`

- [ ] **Step 1: 创建文件并实现基础存储/读取函数**

```typescript
/**
 * Failure Lessons — automatic extraction and retrieval of coding lessons.
 *
 * Stores structured lessons under `.suncode/lessons/` so the agent
 * can recall past failures and avoid repeating them.
 *
 * ## On-disk layout
 *
 *   .suncode/lessons/
 *   ├── LESSONS.md              ← merged index (categorized by type)
 *   └── <date>-<slug>.md       ← per-lesson file with YAML frontmatter
 *
 * ## Limits
 *   - Max lessons configurable via settings (default 200).
 *   - Single lesson file ≤ 2KB.
 *   - Duplicate detection: Jaccard similarity > 0.8 on title+problem → skip.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MAX_LESSONS,
  CHARS_PER_TOKEN,
} from '@shared/constants';
import type {
  LessonEntry,
  LessonIndex,
  LessonSearchResult,
  LessonTriggerType,
  LessonExtractionContext,
  Message,
} from '@shared/types';

// ---- Paths ----

const LESSONS_DIR = '.suncode/lessons';
const LESSONS_INDEX = 'LESSONS.md';

function lessonsDir(workingDir: string): string {
  return join(workingDir, LESSONS_DIR);
}

function indexPath(workingDir: string): string {
  return join(lessonsDir(workingDir), LESSONS_INDEX);
}

// ---- Read Index ----

/** Parse LESSONS.md into a LessonIndex structure. */
export function loadLessonIndex(workingDir: string): LessonIndex {
  const path = indexPath(workingDir);
  if (!existsSync(path)) {
    return { entries: [], updatedAt: '' };
  }

  const content = readFileSync(path, 'utf-8');
  const entries: LessonEntry[] = [];

  // Parse each category section
  const sections = content.split(/\n(?=## )/);
  for (const section of sections) {
    const headerMatch = section.match(/^## (\w+) \((\d+)\)/);
    if (!headerMatch) continue;
    const type = headerMatch[1]! as LessonTriggerType;

    // Parse entries: `- [title](slug.md) | tool | keywords`
    const entryLines = section.match(/^- \[(.+?)\]\((.+?)\) \| (\S*) \| (.+)$/gm);
    if (!entryLines) continue;

    for (const line of entryLines) {
      const m = line.match(/^- \[(.+?)\]\((.+?)\) \| (\S*) \| (.+)$/);
      if (!m) continue;
      entries.push({
        title: m[1]!,
        slug: m[2]!.replace('.md', ''),
        tool: m[3]!,
        keywords: m[4]!.split(',').map((k) => k.trim()),
        type,
        date: '',  // populated when read
        runId: '',
        problem: '',
        rootCause: '',
        solution: '',
        files: [],
      });
    }
  }

  return { entries, updatedAt: new Date().toISOString() };
}

/** Load a single lesson file and return the full LessonEntry. */
export function loadLessonFile(
  workingDir: string,
  slug: string,
): LessonEntry | null {
  const filePath = join(lessonsDir(workingDir), `${slug}.md`);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    return parseLessonMarkdown(content, slug);
  } catch {
    return null;
  }
}

/** Parse a single lesson .md file (YAML frontmatter + markdown body). */
function parseLessonMarkdown(content: string, slug: string): LessonEntry {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const frontmatter: Record<string, string> = {};
  let body = content;

  if (fmMatch) {
    const yamlBlock = fmMatch[1]!;
    body = fmMatch[2]!.trim();
    for (const line of yamlBlock.split('\n')) {
      const m = line.match(/^(\w[\w-]*):\s*(.*?)\s*$/);
      if (m) frontmatter[m[1]!] = m[2]!;
    }
  }

  // Parse body sections: ## 问题, ## 根因, ## 正确做法
  const problemMatch = body.match(/## 问题\n([\s\S]*?)(?=\n## |$)/);
  const rootCauseMatch = body.match(/## 根因\n([\s\S]*?)(?=\n## |$)/);
  const solutionMatch = body.match(/## 正确做法\n([\s\S]*?)(?=\n## |$)/);

  const parseKeywords = (raw: string): string[] => {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return raw.split(',').map((k) => k.trim()).filter(Boolean);
    }
  };

  const parseFiles = (raw: string): string[] => {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return raw ? [raw] : [];
    }
  };

  return {
    slug,
    type: (frontmatter.type as LessonTriggerType) || 'tool_failure',
    tool: frontmatter.tool || '',
    keywords: parseKeywords(frontmatter.keywords || ''),
    files: parseFiles(frontmatter.files || ''),
    date: frontmatter.date || '',
    runId: frontmatter.run_id || '',
    title: frontmatter.title || '',
    problem: (problemMatch?.[1] || '').trim(),
    rootCause: (rootCauseMatch?.[1] || '').trim(),
    solution: (solutionMatch?.[1] || '').trim(),
  };
}

// ---- Save Lesson ----

/** Persist a single lesson and rebuild the index. */
export function saveLesson(
  workingDir: string,
  entry: LessonEntry,
  maxLessons: number = DEFAULT_MAX_LESSONS,
): void {
  const dir = lessonsDir(workingDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write the per-lesson file
  const filePath = join(dir, `${entry.date}-${entry.slug}.md`);
  const fileContent = formatLessonMarkdown(entry);
  writeFileSync(filePath, fileContent, 'utf-8');

  // Prune old files
  pruneOldLessons(workingDir, maxLessons);

  // Rebuild the merged index
  rebuildLessonIndex(workingDir);
}

/** Format a LessonEntry as a lesson .md file. */
function formatLessonMarkdown(entry: LessonEntry): string {
  const lines = [
    '---',
    `type: ${entry.type}`,
    `tool: ${entry.tool}`,
    `keywords: [${entry.keywords.join(', ')}]`,
    `files: [${entry.files.join(', ')}]`,
    `date: ${entry.date}`,
    `run_id: ${entry.runId}`,
    `title: ${entry.title}`,
    '---',
    '',
    `# ${entry.title}`,
    '',
    '## 问题',
    '',
    entry.problem,
    '',
    '## 根因',
    '',
    entry.rootCause,
    '',
    '## 正确做法',
    '',
    entry.solution,
  ];

  const full = lines.join('\n');
  // Enforce 2KB size limit
  return full.slice(0, 2048);
}

/** Delete oldest lessons when exceeding max. */
function pruneOldLessons(workingDir: string, maxLessons: number): void {
  const dir = lessonsDir(workingDir);
  if (!existsSync(dir)) return;

  const files = listLessonFiles(dir);
  if (files.length <= maxLessons) return;

  for (const file of files.slice(maxLessons)) {
    try {
      unlinkSync(join(dir, file!));
    } catch {
      /* skip */
    }
  }
}

/** Rebuild LESSONS.md from all lesson files. */
function rebuildLessonIndex(workingDir: string): void {
  const dir = lessonsDir(workingDir);
  const files = listLessonFiles(dir);
  if (files.length === 0) {
    writeFileSync(
      indexPath(workingDir),
      '<!-- SunCode lessons index — auto-generated -->\n',
      'utf-8',
    );
    return;
  }

  // Group by type
  const byType = new Map<LessonTriggerType, LessonEntry[]>();
  const allEntries: LessonEntry[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file!), 'utf-8');
      const slug = file!.replace('.md', '');
      const entry = parseLessonMarkdown(content, slug);
      allEntries.push(entry);
      const group = byType.get(entry.type) || [];
      group.push(entry);
      byType.set(entry.type, group);
    } catch {
      // Skip unreadable files
    }
  }

  // Sort by date descending within each group
  for (const [, group] of byType) {
    group.sort((a, b) => b.date.localeCompare(a.date));
  }

  const lines: string[] = [
    '<!-- SunCode lessons index — auto-generated -->',
    `> 共 ${allEntries.length} 条教训记录。`,
    '',
  ];

  const typeNames: Record<string, string> = {
    tool_failure: '工具执行失败',
    user_correction: '用户纠正',
    run_error: '运行错误',
    goal_repeated_failure: '目标反复失败',
  };

  for (const [type, entries] of byType) {
    lines.push(`## ${type} (${entries.length}) — ${typeNames[type] || type}`);
    for (const e of entries) {
      const slug = `${e.date}-${e.slug}`;
      lines.push(
        `- [${e.title}](${slug}.md) | ${e.tool} | ${e.keywords.join(',')}`,
      );
    }
    lines.push('');
  }

  writeFileSync(indexPath(workingDir), lines.join('\n'), 'utf-8');
}

/** List lesson files (excl. LESSONS.md) sorted newest-first by filename. */
function listLessonFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== LESSONS_INDEX)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ---- Search ----

/**
 * Search lessons by query string.
 * Matches against keywords (exact), title (substring), type, tool.
 * Returns results sorted by score (desc) then date (desc).
 */
export function searchLessons(
  workingDir: string,
  query: string,
  filterType?: LessonTriggerType,
  maxResults = 3,
): LessonSearchResult[] {
  const index = loadLessonIndex(workingDir);
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(Boolean);

  const results: LessonSearchResult[] = [];

  for (const entry of index.entries) {
    if (filterType && entry.type !== filterType) continue;

    let score = 0;

    // Exact keyword match (high weight)
    for (const kw of entry.keywords) {
      const kwLower = kw.toLowerCase();
      if (queryLower.includes(kwLower)) score += 3;
      for (const term of queryTerms) {
        if (kwLower === term) score += 5;
      }
    }

    // Tool name match
    if (entry.tool && queryLower.includes(entry.tool.toLowerCase())) {
      score += 2;
    }

    // Title substring match
    if (entry.title.toLowerCase().includes(queryLower)) {
      score += 4;
    }
    for (const term of queryTerms) {
      if (entry.title.toLowerCase().includes(term)) score += 1;
    }

    // Problem substring match
    if (entry.problem.toLowerCase().includes(queryLower)) {
      score += 1;
    }

    if (score > 0) {
      results.push({ entry, score });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

/**
 * Quick match against LESSONS.md for tool result enhancement.
 * Only checks tool name + first 100 chars of error message.
 * Returns at most 1 matching entry slug (for the "nudge" line).
 */
export function quickMatchLesson(
  workingDir: string,
  toolName: string,
  errorText: string,
): LessonSearchResult | null {
  const query = `${toolName} ${errorText.slice(0, 100)}`;
  const results = searchLessons(workingDir, query, undefined, 1);
  return results.length > 0 ? results[0]! : null;
}

// ---- Similarity (for deduplication) ----

/** Jaccard similarity between two strings (word-level). */
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Check if a lesson is a duplicate of any existing lesson. */
export function isDuplicateLesson(
  workingDir: string,
  title: string,
  problem: string,
): boolean {
  const index = loadLessonIndex(workingDir);
  const combined = `${title} ${problem}`;

  for (const entry of index.entries) {
    const existing = `${entry.title} ${entry.problem}`;
    if (jaccardSimilarity(combined, existing) > 0.8) {
      return true;
    }
  }

  return false;
}

// ---- Rate Limiting ----

/** In-memory rate limit tracker: key → last extraction time. */
const extractionTimestamps = new Map<string, number>();

/** Check if the same triggerType+toolName has been extracted within 24 hours. */
export function isRateLimited(
  triggerType: string,
  toolName: string,
): boolean {
  const key = `${triggerType}:${toolName}`;
  const lastTime = extractionTimestamps.get(key);
  if (lastTime && Date.now() - lastTime < 24 * 60 * 60 * 1000) {
    return true;
  }
  extractionTimestamps.set(key, Date.now());
  return false;
}

/** Reset rate limit tracking (for testing). */
export function resetRateLimits(): void {
  extractionTimestamps.clear();
}

// ---- Build Extraction Context ----

/**
 * Build a LessonExtractionContext from a completed agent run.
 * Scans messages for failure patterns.
 */
export function buildExtractionContexts(
  messages: Message[],
  runId: string,
  goalRepeatedFailure?: { description: string; verificationOutput: string },
): LessonExtractionContext[] {
  const contexts: LessonExtractionContext[] = [];
  const usedKeys = new Set<string>();

  // Find assistant messages with failed tool calls
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || !msg.toolCalls) continue;

    for (const tc of msg.toolCalls) {
      // Find corresponding tool result
      const toolMsg = messages
        .slice(i + 1)
        .find(
          (m) =>
            m.role === 'tool' && m.toolCallId === tc.id,
        );

      if (toolMsg) {
        const resultText =
          typeof toolMsg.content === 'string'
            ? toolMsg.content
            : toolMsg.content
                .map((b) => ('text' in b ? b.text : ''))
                .join('');

        if (resultText.startsWith('错误:')) {
          const key = `tool_failure:${tc.name}`;
          if (!usedKeys.has(key) && !isRateLimited('tool_failure', tc.name)) {
            usedKeys.add(key);
            contexts.push({
              triggerType: 'tool_failure',
              relevantMessages: [msg, toolMsg],
              error: resultText,
              runId,
            });
          }
        }
      }
    }
  }

  // Find user corrections: user msg with 不对/应该/不要/改成 after assistant with tools
  for (let i = 1; i < messages.length; i++) {
    const userMsg = messages[i]!;
    const prevMsg = messages[i - 1]!;
    if (userMsg.role !== 'user') continue;
    if (prevMsg.role !== 'assistant' || !prevMsg.toolCalls?.length) continue;

    const text =
      typeof userMsg.content === 'string'
        ? userMsg.content
        : userMsg.content
            .filter((b) => b.type === 'text')
            .map((b) => ('text' in b ? b.text : ''))
            .join('');

    if (/不对|不应该|不要|改成|错了|纠正/.test(text)) {
      const key = 'user_correction';
      if (!usedKeys.has(key)) {
        usedKeys.add(key);
        contexts.push({
          triggerType: 'user_correction',
          relevantMessages: [prevMsg, userMsg],
          runId,
        });
      }
    }
  }

  // Goal repeated failure
  if (goalRepeatedFailure) {
    const key = 'goal_repeated_failure';
    if (!usedKeys.has(key)) {
      usedKeys.add(key);
      contexts.push({
        triggerType: 'goal_repeated_failure',
        relevantMessages: [],
        error: `Goal: ${goalRepeatedFailure.description}\nVerification: ${goalRepeatedFailure.verificationOutput.slice(0, 500)}`,
        runId,
      });
    }
  }

  // Cap to 3 per run
  return contexts.slice(0, 3);
}
```

- [ ] **Step 2: 验证 lessons.ts 模块语法正确**

Run: `npx tsc --noEmit src/worker/agent/lessons.ts`
Expected: 无类型错误（若报缺少 Message 类型则是 import 路径问题，需调整）

- [ ] **Step 3: Commit**

```bash
git add src/worker/agent/lessons.ts
git commit -m "feat(lessons): add core lessons module — storage, indexing, search, dedup"
```

---

### Task 4: LLM 提取函数（追加到 lessons.ts）

**Files:**

- Modify: `src/worker/agent/lessons.ts` (追加提取函数)

- [ ] **Step 1: 在 lessons.ts 末尾追加 extractLessonsWithLLM 和相关辅助函数**

```typescript
// ---- LLM Extraction ----

import { LITE_MODELS } from '@shared/constants';
import { randomUUID } from 'node:crypto';

/** LLM-extracted lesson (raw output before file formatting). */
interface RawLessonOutput {
  extracted: boolean;
  title?: string;
  problem?: string;
  rootCause?: string;
  solution?: string;
  keywords?: string[];
  toolName?: string;
  filePaths?: string[];
  errorType?: LessonTriggerType;
}

const EXTRACTION_PROMPT = `你是一个编程教训提炼器。分析以下编码会话中的失败场景，
提取一条可以复用的教训，帮助未来避免同样的问题。

规则：
- 只提取一条最关键的教训
- 聚焦于可操作的具体做法，而非模糊建议
- 包含具体的文件路径、工具名、命令等细节
- 如果失败原因不明确或无可操作教训，返回 extracted: false
- 返回 JSON 格式，不要其他任何文字

输入上下文：
- 触发类型：{triggerType}
- 用户目标：{userGoal}
- 失败详情：
{relevantContext}

返回 JSON（只返回 JSON，不要其他文字，不要 markdown 代码块）：
{
  "extracted": true,
  "title": "一句话标题（中文，≤30字）",
  "problem": "发生了什么问题（≤200字）",
  "rootCause": "根本原因（≤200字）",
  "solution": "正确的做法（≤200字）",
  "keywords": ["关键词1", "关键词2"],
  "toolName": "涉及的工具名",
  "filePaths": ["相关文件路径"],
  "errorType": "tool_failure"
}`;

/** Build the user prompt part of the extraction context. */
function buildExtractionUserPrompt(ctx: LessonExtractionContext): string {
  const parts: string[] = [];

  // Try to find the original user message
  for (const msg of ctx.relevantMessages) {
    if (msg.role === 'user') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((b) => b.type === 'text')
              .map((b) => ('text' in b ? b.text : ''))
              .join(' ');
      if (text) {
        parts.push(`用户目标: ${text.slice(0, 300)}`);
        break;
      }
    }
  }

  // Add error/failure details
  if (ctx.error) {
    parts.push(`失败详情: ${ctx.error.slice(0, 1000)}`);
  }

  // Add relevant assistant + tool messages
  for (const msg of ctx.relevantMessages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        parts.push(`工具调用: ${tc.name}(${tc.arguments.slice(0, 200)})`);
      }
    }
  }

  return parts.join('\n\n');
}

/** Call a lightweight LLM to extract a lesson from a failure context. */
export async function extractLessonWithLLM(
  ctx: LessonExtractionContext,
  workingDir: string,
  provider: string,
): Promise<RawLessonOutput | null> {
  try {
    const pi = await import('@earendil-works/pi-ai');
    const streamSimple = pi.streamSimple as
      | ((
          model: unknown,
          context: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => AsyncIterable<{ type: string; delta?: string; message?: Record<string, unknown> }>)
      | undefined;

    if (!streamSimple) return null;

    // Resolve the lite model
    const liteModelId = LITE_MODELS[provider] || `${provider}/default`;
    const getModel = pi.getModel as
      | ((p: string, m: string) => unknown)
      | undefined;
    if (!getModel) return null;

    const model = getModel(provider, liteModelId);
    if (!model) return null;

    const prompt = EXTRACTION_PROMPT
      .replace('{triggerType}', ctx.triggerType)
      .replace('{userGoal}', buildExtractionUserPrompt(ctx))
      .replace('{relevantContext}', ctx.error || '');

    const context = {
      systemPrompt: '你是一个编程教训提炼器。只返回 JSON。',
      messages: [{ role: 'user', content: prompt }],
      tools: [],
    };

    let responseText = '';
    const stream = streamSimple(model, context, {
      reasoning: 'minimal',
      signal: AbortSignal.timeout(30_000),
    });

    for await (const event of stream) {
      if (event.type === 'text_delta' && event.delta) {
        responseText += event.delta;
      }
      if (event.type === 'error') {
        return null;
      }
    }

    // Parse JSON response
    const jsonStr = responseText
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    try {
      const parsed = JSON.parse(jsonStr) as RawLessonOutput;
      return parsed;
    } catch {
      // Try to find JSON object in the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]) as RawLessonOutput;
        } catch {
          return null;
        }
      }
      return null;
    }
  } catch {
    return null;
  }
}

/** Generate a slug from a title string. */
export function slugFromTitle(title: string): string {
  return title
    .slice(0, 30)
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    || 'lesson';
}

/**
 * Main entry point: extract lessons from failure contexts,
 * dedup, and save to .suncode/lessons/.
 * Fire-and-forget — never throws.
 */
export async function extractAndSaveLessons(
  contexts: LessonExtractionContext[],
  workingDir: string,
  provider: string,
  maxLessons: number = DEFAULT_MAX_LESSONS,
): Promise<void> {
  for (const ctx of contexts) {
    try {
      const raw = await extractLessonWithLLM(ctx, workingDir, provider);
      if (!raw?.extracted || !raw.title || !raw.problem) continue;

      // Dedup check
      if (isDuplicateLesson(workingDir, raw.title, raw.problem)) continue;

      const slug = slugFromTitle(raw.title);
      const entry: LessonEntry = {
        slug,
        type: raw.errorType || ctx.triggerType,
        tool: raw.toolName || '',
        keywords: raw.keywords || [],
        files: raw.filePaths || [],
        date: new Date().toISOString().split('T')[0]!,
        runId: ctx.runId,
        title: raw.title.slice(0, 30),
        problem: raw.problem.slice(0, 200),
        rootCause: raw.rootCause?.slice(0, 200) || '',
        solution: raw.solution?.slice(0, 200) || '',
      };

      saveLesson(workingDir, entry, maxLessons);
    } catch {
      // Best-effort — never let lesson extraction break the agent
    }
  }
}
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit src/worker/agent/lessons.ts`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add src/worker/agent/lessons.ts
git commit -m "feat(lessons): add LLM-powered lesson extraction with dedup and rate limiting"
```

---

### Task 5: search_lessons 工具

**Files:**

- Create: `src/worker/tools/search-lessons.ts`

- [ ] **Step 1: 创建 search-lessons.ts**

```typescript
import { BaseTool, obj, p } from './types';
import { searchLessons, loadLessonFile } from '../agent/lessons';
import type { LessonTriggerType } from '@shared/types';

/**
 * search_lessons tool — searches the failure lessons library.
 * Read-only, available in all permission modes.
 */
export function createSearchLessonsTool(workingDir: string) {
  return new (class SearchLessonsTool extends BaseTool {
    readonly name = 'search_lessons';
    readonly isReadonly = true;
    readonly description =
      '搜索失败教训库，查找与当前问题相关的历史教训。返回匹配的教训内容（问题描述、根因、正确做法）。' +
      '当你遇到工具执行失败、重复出错或不确定正确做法时，使用此工具查找历史经验。';
    readonly parameters = obj(
      {
        query: p(
          'string',
          '搜索关键词，如工具名、错误信息、文件路径、技术术语等',
        ),
        errorType: p(
          'string',
          '教训类型筛选：tool_failure | user_correction | run_error | goal_repeated_failure',
          { enum: ['tool_failure', 'user_correction', 'run_error', 'goal_repeated_failure'] },
        ),
        limit: p('integer', '最多返回条数，默认 3'),
      },
      ['query'],
    );

    async execute(params: Record<string, unknown>): Promise<ReturnType<BaseTool['execute']>> {
      const query = params.query as string;
      const errorType = params.errorType as LessonTriggerType | undefined;
      const limit = (params.limit as number) || 3;

      if (!query) {
        return this.failure('query is required');
      }

      const results = searchLessons(workingDir, query, errorType, Math.min(limit, 10));

      if (results.length === 0) {
        return this.success(
          `未找到与 "${query}" 相关的教训记录。`,
        );
      }

      const lines: string[] = [
        `找到 ${results.length} 条相关教训：`,
        '',
      ];

      for (let i = 0; i < results.length; i++) {
        const sr = results[i]!;
        const full = loadLessonFile(workingDir, sr.entry.slug);
        const entry = full || sr.entry;

        const typeLabels: Record<string, string> = {
          tool_failure: '工具执行失败',
          user_correction: '用户纠正',
          run_error: '运行错误',
          goal_repeated_failure: '目标反复失败',
        };

        lines.push(`### ${entry.title}`);
        lines.push(`- 类型: ${entry.type} (${typeLabels[entry.type] || entry.type}) | 工具: ${entry.tool || '无'} | 日期: ${entry.date}`);
        if (entry.problem) {
          lines.push(`- 问题: ${entry.problem}`);
        }
        if (entry.rootCause) {
          lines.push(`- 根因: ${entry.rootCause}`);
        }
        if (entry.solution) {
          lines.push(`- 正确做法: ${entry.solution}`);
        }
        if (entry.files.length > 0) {
          lines.push(`- 相关文件: ${entry.files.join(', ')}`);
        }
        lines.push('');
      }

      return this.success(lines.join('\n'));
    }
  })();
}
```

- [ ] **Step 2: 在 registry.ts 注册 search_lessons 工具**

在 `createToolRegistry` 函数中，在 `registry.register(createWebSearchTool(settings));` 之后添加：

```typescript
  registry.register(createSearchLessonsTool(workingDir));
```

同时在文件顶部 import 区域添加：

```typescript
import { createSearchLessonsTool } from './search-lessons';
```

- [ ] **Step 3: 验证编译**

Run: `npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add src/worker/tools/search-lessons.ts src/worker/tools/registry.ts
git commit -m "feat(lessons): add search_lessons tool and register in registry"
```

---

### Task 6: Agent 集成 — 触发提取

**Files:**

- Modify: `src/worker/agent/agent.ts`

- [ ] **Step 1: 在 agent.ts 导入 lessons 模块**

在文件顶部现有 import 区域添加：

```typescript
import { buildExtractionContexts, extractAndSaveLessons } from './lessons';
```

- [ ] **Step 2: 在 runLoop() 末尾添加提取调用**

在 `runLoop()` 方法中，`this.saveSessionMemory();` 之后、`this.emitStatus('done');` 之前，添加：

```typescript
    // Extract failure lessons (fire-and-forget)
    const hasFailures = this.messages.some(
      (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.startsWith('错误:'),
    );
    if (hasFailures) {
      const extractionContexts = buildExtractionContexts(
        this.messages,
        runId,
      );
      if (extractionContexts.length > 0) {
        extractAndSaveLessons(
          extractionContexts,
          this.workingDir,
          this.settings.activeProvider,
          this.settings.maxLessons,
        ).catch(() => {
          // Never let lesson extraction break the agent
        });
      }
    }
```

- [ ] **Step 3: 在 runGoalLoop() 末尾添加提取调用**

在 `runGoalLoop()` 方法中 `this.saveSessionMemory();` 之前，添加：

```typescript
    // Extract failure lessons from goal loop (fire-and-forget)
    const goalFailed =
      goalResult.state.status !== 'verification_passed';
    const goalRepeatedFailure =
      goalResult.state.status === 'blocked' && goalResult.state.lastVerificationOutput
        ? {
            description: goalDef.description,
            verificationOutput: goalResult.state.lastVerificationOutput,
          }
        : undefined;

    const extractionContexts = buildExtractionContexts(
      this.messages,
      runId,
      goalRepeatedFailure,
    );
    if (extractionContexts.length > 0 || goalFailed) {
      extractAndSaveLessons(
        extractionContexts,
        this.workingDir,
        this.settings.activeProvider,
        this.settings.maxLessons,
      ).catch(() => {
        // Never let lesson extraction break the agent
      });
    }
```

- [ ] **Step 4: 验证编译**

Run: `npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 5: Commit**

```bash
git add src/worker/agent/agent.ts
git commit -m "feat(lessons): integrate lesson extraction into agent run/goal loops"
```

---

### Task 7: Agent Loop — 工具结果增强

**Files:**

- Modify: `src/worker/agent/agent-loop.ts`

- [ ] **Step 1: 在 agent-loop.ts 导入 quickMatchLesson**

在文件顶部 import 区域添加：

```typescript
import { quickMatchLesson } from './lessons';
```

- [ ] **Step 2: 在工具执行完成后添增强逻辑**

在 `agent-loop.ts` 的 `// Phase 2: Execute all valid tools in parallel` 块中，找到 `for (const s of settled)` 循环处理结果的区域。

在 `for (const s of settled)` 循环之后、`console.log('[AgentLoop] Tools done:...')` 之前，添加增强逻辑：

```typescript
        // Enhance failed tool results with lesson hints
        for (const tr of toolResults) {
          if (!tr.success && tr.error && workingDir) {
            try {
              const match = quickMatchLesson(workingDir, tr.name, tr.error);
              if (match) {
                tr.output = `⚠️ 相关教训：[${match.entry.date}] ${match.entry.title}\n   使用 search_lessons 工具查看详情。\n\n${tr.output}`;
              }
            } catch {
              // Never let lesson matching break tool execution
            }
          }
        }
```

注意：需要访问 `workingDir` 变量，它在函数参数中已存在。放置位置应该在 toolResults 构建完成之后、写入 contextMessages 之前。

- [ ] **Step 3: 验证编译**

Run: `npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add src/worker/agent/agent-loop.ts
git commit -m "feat(lessons): enhance failed tool results with relevant lesson hints"
```

---

### Task 8: 端到端验证

- [ ] **Step 1: 完整 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 2: 运行现有测试确保无回归**

Run: `npm test`
Expected: 所有已有测试通过

- [ ] **Step 3: 验证 lessons 模块可在 Node.js 独立运行**

创建简单的临时测试脚本：

```bash
node -e "
const { loadLessonIndex, searchLessons } = require('./dist-electron/worker/agent/lessons.js');
const idx = loadLessonIndex('.');
console.log('Index loaded:', idx.entries.length, 'entries');
"
```

注意：需要先 `npm run build` 或通过 vite 编译。

- [ ] **Step 4: 提交最终版本**

```bash
git add -A
git commit -m "feat(lessons): verify end-to-end compilation and test suite"
```
