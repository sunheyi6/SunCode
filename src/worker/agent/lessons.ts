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
import { DEFAULT_MAX_LESSONS } from '@shared/constants';
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
        date: '', // populated when read
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

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file!), 'utf-8');
      const slug = file!.replace('.md', '');
      const entry = parseLessonMarkdown(content, slug);
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

  const allEntries = [...byType.values()].flat();
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
  if (!query) return [];

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
 * Quick match against lessons for tool result enhancement.
 * Only checks tool name + first 100 chars of error message.
 * Returns at most 1 matching entry (for the "nudge" line).
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
 * Build LessonExtractionContext objects from a completed agent run.
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
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
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
            .map((b) => b.text)
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

// ---- LLM Extraction ----

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
              .map((b) => b.text)
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
async function extractLessonWithLLM(
  ctx: LessonExtractionContext,
  provider: string,
): Promise<RawLessonOutput | null> {
  try {
    const pi = await import('@earendil-works/pi-ai');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamSimple = (pi as any).streamSimple as
      | ((
          model: unknown,
          context: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => AsyncIterable<{ type: string; delta?: string; message?: Record<string, unknown> }>)
      | undefined;

    if (!streamSimple) return null;

    // Resolve the lite model using LITE_MODELS mapping
    const { LITE_MODELS } = await import('@shared/constants');
    const liteModelId = LITE_MODELS[provider] || undefined;
    if (!liteModelId) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getModel = (pi as any).getModel as
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
      return JSON.parse(jsonStr) as RawLessonOutput;
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
 * dedup, and save. Fire-and-forget — never throws.
 */
export async function extractAndSaveLessons(
  contexts: LessonExtractionContext[],
  workingDir: string,
  provider: string,
  maxLessons: number = DEFAULT_MAX_LESSONS,
): Promise<void> {
  for (const ctx of contexts) {
    try {
      const raw = await extractLessonWithLLM(ctx, provider);
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
