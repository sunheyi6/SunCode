import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Message } from '@shared/types';
import { getAgentDataSubdir } from './agent-data-dir';
import { buildStructuredTaskPrompt } from './model-structured-content';

const MEMORIES_DIR = '.suncode/memories';
const MEMORY_INDEX = 'MEMORY.md';
const MEMORY_INDEX_JSON = 'MEMORY.json';
const MAX_FILES = 30;
const MAX_SUMMARY_LENGTH = 500;
const MAX_RETRIEVED_MEMORIES = 5;

export type MemoryScope = 'session' | 'project';
export type MemoryKind =
  | 'task_summary'
  | 'project_fact'
  | 'decision'
  | 'preference'
  | 'lesson'
  | 'ephemeral';

export interface MemoryEntry {
  date: string;
  slug: string;
  userRequest: string;
  toolsUsed: Record<string, number>;
  summary: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  embedding?: number[];
  importance?: number;
  tags?: string[];
  accessCount?: number;
  updatedAt?: string;
  expiresAt?: string;
  pinned?: boolean;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface SessionSnapshot {
  sessionId: string;
  workingDir: string;
  status: 'idle' | 'paused' | 'interrupted' | 'completed';
  lastUserGoal: string;
  summary: string;
  activeFiles: string[];
  pendingTasks: string[];
  updatedAt: string;
  lastPlan?: string;
}

const embeddingCache: Map<string, number[]> = new Map();

export async function loadMemories(
  workingDir: string,
  query?: string,
  sessionId?: string,
): Promise<string> {
  const entries = [
    ...loadScopedMemoryEntries(projectMemoryDir(workingDir), 'project'),
    ...loadScopedMemoryEntries(sessionMemoryDir(workingDir, sessionId), 'session'),
  ];
  if (entries.length === 0) return '';

  const selectedEntries = query?.trim()
    ? await searchMemories(entries, query)
    : entries.slice(0, Math.min(entries.length, MAX_RETRIEVED_MEMORIES));

  const content = formatMemoryIndex(selectedEntries);
  return content.slice(0, 4000);
}

export async function saveMemory(
  workingDir: string,
  entry: MemoryEntry,
  provider?: string,
  modelId?: string,
  sessionId?: string,
): Promise<void> {
  const scope = entry.scope ?? (sessionId ? 'session' : 'project');
  const memDir =
    scope === 'project' ? projectMemoryDir(workingDir) : sessionMemoryDir(workingDir, sessionId);
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true });
  }

  let finalEntry: MemoryEntry = {
    kind: 'task_summary',
    importance: 1,
    accessCount: 0,
    updatedAt: new Date().toISOString(),
    ...entry,
    scope,
  };

  if (!entry.summary && provider && modelId) {
    try {
      const summary = await generateSummary(entry, provider, modelId);
      finalEntry = { ...finalEntry, summary: summary.slice(0, MAX_SUMMARY_LENGTH) };
    } catch (e) {
      console.warn('Failed to generate memory summary:', e);
    }
  }

  try {
    finalEntry.embedding = await computeEmbedding(finalEntry);
  } catch (e) {
    console.warn('Failed to compute embedding:', e);
  }

  const sessionPath = join(memDir, `${finalEntry.date}-${finalEntry.slug}.md`);
  writeFileSync(sessionPath, formatSessionMemory(finalEntry), 'utf-8');

  pruneOldMemories(memDir);
  rebuildIndexes(memDir);
}

export async function searchMemories(
  entries: MemoryEntry[],
  query: string,
): Promise<MemoryEntry[]> {
  if (entries.length === 0 || !query.trim()) {
    return entries.slice(0, MAX_RETRIEVED_MEMORIES);
  }

  const results = entries
    .map((entry) => ({ entry, score: scoreMemory(entry, query) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score);

  return results.slice(0, MAX_RETRIEVED_MEMORIES).map((r) => r.entry);
}

export function updateMemory(
  workingDir: string,
  date: string,
  slug: string,
  updates: Partial<MemoryEntry>,
  sessionId?: string,
): void {
  const memDir = sessionMemoryDir(workingDir, sessionId);
  const sessionPath = join(memDir, `${date}-${slug}.md`);

  if (!existsSync(sessionPath)) {
    throw new Error(`Memory not found: ${date}-${slug}`);
  }

  const entry = parseSessionMemory(readFileSync(sessionPath, 'utf-8'));
  Object.assign(entry, updates, { updatedAt: new Date().toISOString() });
  writeFileSync(sessionPath, formatSessionMemory(entry), 'utf-8');
  rebuildIndexes(memDir);
}

export function deleteMemory(
  workingDir: string,
  date: string,
  slug: string,
  sessionId?: string,
): void {
  const memDir = sessionMemoryDir(workingDir, sessionId);
  const sessionPath = join(memDir, `${date}-${slug}.md`);

  if (!existsSync(sessionPath)) {
    throw new Error(`Memory not found: ${date}-${slug}`);
  }

  unlinkSync(sessionPath);
  rebuildIndexes(memDir);
}

export function getAllMemories(
  workingDir: string,
  sessionId?: string,
  scope: MemoryScope = sessionId ? 'session' : 'project',
): MemoryEntry[] {
  const memDir =
    scope === 'project' ? projectMemoryDir(workingDir) : sessionMemoryDir(workingDir, sessionId);
  return loadScopedMemoryEntries(memDir, scope);
}

export function saveSessionSnapshot(workingDir: string, snapshot: SessionSnapshot): void {
  const dir = sessionSnapshotDir(workingDir, snapshot.sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf-8');
}

export function loadSessionSnapshot(workingDir: string, sessionId: string): SessionSnapshot | null {
  const path = join(sessionSnapshotDir(workingDir, sessionId), 'snapshot.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as SessionSnapshot;
  } catch {
    return null;
  }
}

export function buildSessionSnapshot(input: {
  sessionId: string;
  workingDir: string;
  status: SessionSnapshot['status'];
  messages: Message[];
}): SessionSnapshot {
  const lastUser = [...input.messages].reverse().find((message) => message.role === 'user');
  const lastAssistant = [...input.messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  const activeFiles = collectReferencedFiles(input.messages);

  return {
    sessionId: input.sessionId,
    workingDir: input.workingDir,
    status: input.status,
    lastUserGoal: lastUser ? messageText(lastUser).slice(0, 500) : '',
    summary: lastAssistant ? messageText(lastAssistant).slice(0, 1000) : '',
    activeFiles,
    pendingTasks: extractPendingTasks(lastAssistant ? messageText(lastAssistant) : ''),
    updatedAt: new Date().toISOString(),
  };
}

export function mergeMemories(
  workingDir: string,
  entries: MemoryEntry[],
  newSlug: string,
  sessionId?: string,
): void {
  const scope = entries.find((entry) => entry.scope === 'project') ? 'project' : 'session';
  const memDir =
    scope === 'project' ? projectMemoryDir(workingDir) : sessionMemoryDir(workingDir, sessionId);
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true });
  }

  const mergedEntry: MemoryEntry = {
    date: todayString(),
    slug: newSlug,
    scope,
    kind: 'task_summary',
    userRequest: entries.map((e) => e.userRequest).join('; '),
    toolsUsed: entries.reduce(
      (acc, e) => {
        for (const [tool, count] of Object.entries(e.toolsUsed)) {
          acc[tool] = (acc[tool] || 0) + count;
        }
        return acc;
      },
      {} as Record<string, number>,
    ),
    summary: entries
      .map((e) => e.summary)
      .filter(Boolean)
      .join('\n\n'),
    importance: Math.max(...entries.map((e) => e.importance ?? 1), 1),
    tags: [...new Set(entries.flatMap((e) => e.tags || []))],
    updatedAt: new Date().toISOString(),
  };

  for (const entry of entries) {
    const sessionPath = join(memDir, `${entry.date}-${entry.slug}.md`);
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  }

  writeFileSync(
    join(memDir, `${mergedEntry.date}-${mergedEntry.slug}.md`),
    formatSessionMemory(mergedEntry),
    'utf-8',
  );
  rebuildIndexes(memDir);
}

function sessionMemoryDir(workingDir: string, sessionId?: string): string {
  return getAgentDataSubdir(workingDir, MEMORIES_DIR, sessionId);
}

function projectMemoryDir(workingDir: string): string {
  const appDataDir = process.env.SUNCODE_APP_DATA;
  if (appDataDir) {
    const hash = createHash('sha256').update(workingDir).digest('hex').slice(0, 16);
    return join(appDataDir, 'projects', hash, 'memories');
  }
  return join(workingDir, MEMORIES_DIR);
}

function sessionSnapshotDir(workingDir: string, sessionId: string): string {
  const appDataDir = process.env.SUNCODE_APP_DATA;
  if (appDataDir) return join(appDataDir, 'sessions', sessionId);
  return join(workingDir, '.suncode', 'sessions', sessionId);
}

function rebuildIndexes(memDir: string): void {
  writeFileSync(join(memDir, MEMORY_INDEX), buildMemoryIndex(memDir), 'utf-8');
  writeFileSync(
    join(memDir, MEMORY_INDEX_JSON),
    JSON.stringify(loadAllMemoryEntries(memDir), null, 2),
    'utf-8',
  );
}

function formatSessionMemory(entry: MemoryEntry): string {
  const toolList = Object.entries(entry.toolsUsed)
    .map(([name, count]) => `  - ${name} x${count}`)
    .join('\n');

  const tagList = entry.tags?.map((t) => `#${t}`).join(' ') || '';

  return [
    '---',
    `date: ${entry.date}`,
    `scope: ${entry.scope ?? 'session'}`,
    `kind: ${entry.kind ?? 'task_summary'}`,
    `importance: ${entry.importance ?? 1}`,
    `accessCount: ${entry.accessCount ?? 0}`,
    ...(entry.updatedAt ? [`updatedAt: ${entry.updatedAt}`] : []),
    ...(entry.expiresAt ? [`expiresAt: ${entry.expiresAt}`] : []),
    ...(entry.pinned ? ['pinned: true'] : []),
    ...(entry.tags && entry.tags.length > 0 ? [`tags: ${entry.tags.join(', ')}`] : []),
    ...(entry.embedding ? [`embedding: ${JSON.stringify(entry.embedding)}`] : []),
    '---',
    '',
    `## ${entry.userRequest.slice(0, 80)}`,
    ...(tagList ? [`\n${tagList}`] : []),
    '',
    '**工具使用**:',
    toolList || '  (none)',
    '',
    '**摘要**:',
    entry.summary || '(none)',
    '',
  ].join('\n');
}

function parseSessionMemory(content: string): MemoryEntry {
  const lines = content.split('\n');
  let bodyStart = 0;
  const frontmatter: Record<string, string> = {};

  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end !== -1) {
      bodyStart = end + 1;
      for (let i = 1; i < end; i++) {
        const match = lines[i]?.match(/^(\w+):\s*(.+)$/);
        if (match?.[1]) {
          frontmatter[match[1]] = match[2]?.trim() ?? '';
        }
      }
    }
  }

  const body = lines.slice(bodyStart).join('\n');
  const userRequestMatch = body.match(/^## (.+)$/m);
  const sections = [...body.matchAll(/^\*\*(.+?)\*\*:\s*\n([\s\S]*?)(?=\n\n|$)/gm)];
  const toolsSection =
    sections.find((section) => section[1]?.includes('工具')) ??
    sections.find((section) => section[2]?.includes(' x') || section[2]?.includes('脳'));
  const summarySection =
    sections.find((section) => section[1]?.includes('摘要')) ??
    sections.find((section) => section !== toolsSection);

  const toolsUsed: Record<string, number> = {};
  if (toolsSection) {
    for (const line of (toolsSection[2] ?? '').split('\n')) {
      const toolMatch = line.match(/^\s*-\s*([\w-]+)\s*(?:x|脳)(\d+)/);
      if (toolMatch) {
        toolsUsed[toolMatch[1] ?? ''] = parseInt(toolMatch[2] ?? '', 10);
      }
    }
  }

  return {
    date: frontmatter.date || '',
    slug: '',
    userRequest: userRequestMatch?.[1] || '',
    toolsUsed,
    summary: summarySection?.[2]?.trim() || '',
    scope: (frontmatter.scope as MemoryScope) || undefined,
    kind: (frontmatter.kind as MemoryKind) || undefined,
    importance: frontmatter.importance ? parseFloat(frontmatter.importance) : 1,
    accessCount: frontmatter.accessCount ? parseInt(frontmatter.accessCount, 10) : 0,
    updatedAt: frontmatter.updatedAt,
    expiresAt: frontmatter.expiresAt,
    pinned: frontmatter.pinned === 'true',
    tags: frontmatter.tags ? frontmatter.tags.split(',').map((t) => t.trim()) : [],
    embedding: frontmatter.embedding ? JSON.parse(frontmatter.embedding) : undefined,
  };
}

function buildMemoryIndex(memDir: string): string {
  const files = listMemoryFiles(memDir);
  if (files.length === 0) return '<!-- SunCode memory index - auto-generated -->\n';

  const parts: string[] = [
    '<!-- SunCode memory index - auto-generated -->',
    '',
    `> ${files.length} memory records. Latest ${Math.min(files.length, 10)}:`,
    '',
  ];

  for (let i = 0; i < Math.min(files.length, 10); i++) {
    try {
      const file = files[i];
      if (!file) continue;
      const content = readFileSync(join(memDir, file), 'utf-8');
      const lines = content.split('\n');
      let bodyStart = 0;
      if (lines[0]?.trim() === '---') {
        const end = lines.indexOf('---', 1);
        bodyStart = end === -1 ? 0 : end + 1;
      }
      parts.push(lines.slice(bodyStart).join('\n').trim());
    } catch {
      // Skip unreadable files.
    }
  }

  return `${parts.join('\n')}\n`;
}

function formatMemoryIndex(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';

  const parts: string[] = [
    '<!-- SunCode memory index - auto-generated -->',
    '',
    `> ${entries.length} relevant memories:`,
    '',
  ];

  for (const entry of entries) {
    const toolList =
      Object.entries(entry.toolsUsed)
        .map(([name, count]) => `${name}x${count}`)
        .join(', ') || 'none';
    const tagList = entry.tags?.map((t) => `#${t}`).join(' ') || '';

    parts.push(`## ${entry.date} - ${entry.userRequest.slice(0, 60)}`);
    if (tagList) parts.push(`\n${tagList}`);
    parts.push(`\n**Scope**: ${entry.scope ?? 'session'}`);
    parts.push(`\n**Kind**: ${entry.kind ?? 'task_summary'}`);
    parts.push(`\n**Tools**: ${toolList}`);
    parts.push(`\n**Summary**: ${entry.summary || '(none)'}\n`);
  }

  return parts.join('\n');
}

function pruneOldMemories(memDir: string): void {
  const files = listMemoryFiles(memDir);
  if (files.length <= MAX_FILES) return;

  const ranked = files
    .map((file) => {
      try {
        return {
          file,
          score: memoryRetentionScore(
            parseSessionMemory(readFileSync(join(memDir, file), 'utf-8')),
          ),
        };
      } catch {
        return { file, score: Number.NEGATIVE_INFINITY };
      }
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.file.localeCompare(a.file);
    });

  const keep = new Set(ranked.slice(0, MAX_FILES).map((item) => item.file));
  for (const file of files) {
    if (keep.has(file)) continue;
    try {
      unlinkSync(join(memDir, file));
    } catch {
      // Best-effort pruning.
    }
  }
}

function listMemoryFiles(memDir: string): string[] {
  try {
    return readdirSync(memDir)
      .filter((f) => f.endsWith('.md') && f !== MEMORY_INDEX && f !== MEMORY_INDEX_JSON)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function loadScopedMemoryEntries(memDir: string, scope: MemoryScope): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const file of listMemoryFiles(memDir)) {
    try {
      const entry = parseSessionMemory(readFileSync(join(memDir, file), 'utf-8'));
      const name = file.replace('.md', '');
      const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
      entry.date = dateMatch?.[1] ?? entry.date;
      entry.slug = dateMatch?.[2] ?? name;
      entry.scope = entry.scope ?? scope;
      entries.push(entry);
    } catch {
      // Skip unreadable files.
    }
  }
  return entries;
}

function loadAllMemoryEntries(memDir: string): MemoryEntry[] {
  return loadScopedMemoryEntries(memDir, 'session');
}

function scoreMemory(entry: MemoryEntry, query: string): number {
  const haystack =
    `${entry.userRequest} ${entry.summary} ${(entry.tags ?? []).join(' ')}`.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;

  let score = 0;
  const fullQuery = query.toLowerCase().trim();
  if (fullQuery && haystack.includes(fullQuery)) score += 5;
  for (const term of terms) {
    if (haystack.includes(term)) score += 2;
  }
  score += (entry.importance ?? 1) * 0.25;
  score += Math.min(entry.accessCount ?? 0, 10) * 0.1;
  if (entry.pinned) score += 1;
  return score;
}

function memoryRetentionScore(entry: MemoryEntry): number {
  let score = (entry.importance ?? 1) * 10;
  score += Math.min(entry.accessCount ?? 0, 20);
  if (entry.pinned) score += 1000;
  if (entry.kind === 'decision' || entry.kind === 'project_fact' || entry.kind === 'preference') {
    score += 20;
  }
  if (entry.kind === 'ephemeral') score -= 10;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) score -= 50;
  const updated = Date.parse(entry.updatedAt || entry.date || '');
  if (Number.isFinite(updated)) score += updated / 86_400_000_000;
  return score;
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function collectReferencedFiles(messages: Message[]): string[] {
  const files = new Set<string>();
  const filePattern = /(?:[A-Za-z]:[\\/])?[\w.-]+(?:[\\/][\w.-]+)+/g;

  for (const message of messages.slice(-12)) {
    const text = messageText(message);
    for (const match of text.matchAll(filePattern)) {
      if (match[0]) files.add(match[0].replace(/\\/g, '/'));
    }
    if (message.role === 'assistant' && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        try {
          const args = JSON.parse(toolCall.arguments) as Record<string, unknown>;
          for (const key of ['path', 'file', 'filePath']) {
            const value = args[key];
            if (typeof value === 'string' && value.includes('/')) {
              files.add(value.replace(/\\/g, '/'));
            }
          }
        } catch {
          // Tool arguments are best-effort context hints.
        }
      }
    }
  }

  return [...files].slice(0, 20);
}

function extractPendingTasks(text: string): string[] {
  const pending: string[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*[-*]\s+\[\s?\]\s+(.+)$/);
    if (match?.[1]) pending.push(match[1].trim());
  }
  return pending.slice(0, 20);
}

async function generateSummary(
  entry: MemoryEntry,
  provider: string,
  modelId: string,
): Promise<string> {
  try {
    const pi = await import('@earendil-works/pi-ai');
    const getModel = pi.getModel as unknown as (provider: string, modelId: string) => unknown;
    const complete = pi.complete as unknown as (
      model: unknown,
      context: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<{ content?: Array<{ type: string; text?: string }> } | undefined>;
    const model = getModel(provider, modelId);
    if (!model) {
      console.warn('Model not available for summary generation');
      return '';
    }

    const prompt = `请为以下会话生成一个简洁摘要（最多 500 字符），突出关键成果和经验教训。

用户请求：${entry.userRequest}

工具使用：${Object.entries(entry.toolsUsed)
      .map(([k, v]) => `${k}: ${v} 次`)
      .join(', ')}

请用中文回复，格式为：
- 完成的工作：...
- 关键发现：...
- 经验教训：...`;

    const structuredPrompt = buildStructuredTaskPrompt('memory_summary', {
      instruction: prompt,
      responseFormat: {
        language: 'zh',
        sections: ['completed_work', 'key_findings', 'lessons_learned'],
      },
      userRequest: entry.userRequest,
      toolsUsed: entry.toolsUsed,
    });

    const context = {
      systemPrompt: prompt,
      messages: [{ role: 'user', content: structuredPrompt, timestamp: Date.now() }],
    };

    const result = await complete(model, context, {
      maxTokens: 300,
      temperature: 0.3,
      signal: AbortSignal.timeout(30_000),
    });

    if (result?.content) {
      return result.content
        .filter(
          (c): c is { type: string; text: string } =>
            c.type === 'text' && typeof c.text === 'string',
        )
        .map((c) => c.text)
        .join('')
        .trim()
        .slice(0, MAX_SUMMARY_LENGTH);
    }

    return '';
  } catch (e) {
    console.warn('Summary generation failed:', e);
    return '';
  }
}

async function computeEmbedding(entry: MemoryEntry): Promise<number[]> {
  const text = `${entry.userRequest} ${entry.summary}`;
  const cacheKey = text.slice(0, 200);

  if (embeddingCache.has(cacheKey)) {
    const cached = embeddingCache.get(cacheKey);
    if (cached) return cached;
  }

  const embedding = simpleTextEmbedding(text);
  embeddingCache.set(cacheKey, embedding);
  return embedding;
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function simpleTextEmbedding(text: string): number[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const wordCounts: Record<string, number> = {};
  for (const word of words) {
    wordCounts[word] = (wordCounts[word] || 0) + 1;
  }

  const vocab = [...new Set(words)].slice(0, 100);
  const embedding = vocab.map((word) => wordCounts[word] || 0);
  const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (norm > 0) {
    return embedding.map((val) => val / norm);
  }

  return embedding.length > 0 ? embedding : [0];
}
