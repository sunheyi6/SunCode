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
const MEMSCENES_DIR = 'scenes';
const MAX_FILES = 30;
const MAX_SUMMARY_LENGTH = 500;
const MAX_RETRIEVED_MEMORIES = 5;
const MEMSCENE_SIMILARITY_THRESHOLD = 0.6;
const MEMSCENE_MIN_ENTRIES = 2;
/** Minimum relevance score threshold — memories scoring below this are excluded. */
const MIN_RELEVANCE_SCORE = 1.0;

export type MemoryScope = 'session' | 'project' | 'global';
export type MemoryKind =
  | 'task_summary'
  | 'project_fact'
  | 'decision'
  | 'preference'
  | 'lesson'
  | 'ephemeral';

export interface StructuredFact {
  type: 'fact' | 'preference' | 'decision';
  subject: string;
  predicate: string;
  object: string;
  validity: { start: string; end?: string };
  confidence: number;
}

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
  validFrom?: string;
  pinned?: boolean;
  facts?: StructuredFact[];
  supersedes?: string[];
  sceneId?: string;
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

export interface MemoryScene {
  id: string;
  centroid: number[];
  entries: string[];
  summary: string;
  tags: string[];
  updatedAt: string;
  createdAt: string;
}

const embeddingCache: Map<string, number[]> = new Map();
const sceneCache: Map<string, MemoryScene[]> = new Map();

export interface LoadMemoriesResult {
  content: string;
  entries: MemoryEntry[];
}

export async function loadMemories(
  workingDir: string,
  query?: string,
  sessionId?: string,
): Promise<string> {
  const result = await loadMemoriesWithEntries(workingDir, query, sessionId);
  return result.content;
}

/**
 * Detect casual social/chatty queries that don't need memory retrieval.
 * Skips memory injection for greetings, mood expressions, and chit-chat.
 */
function isSocialQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;

  // File paths, code symbols, CLI flags → always allow memory retrieval
  if (/[/\\:<>{}[\]()=+*|&^%$#@!~`]/.test(trimmed)) return false;

  // Very short text without technical indicators → likely social
  if (trimmed.length <= 6) {
    if (/^[a-zA-Z]{3,}$/.test(trimmed) && !/^(hi|hey|yes|no|ok|bye)$/i.test(trimmed)) return false;
    return true;
  }

  // Greeting patterns
  if (/^(你好|哈[喽罗]|嗨|喂|大家[好]?|早[上安好]?|晚[上安好]?)/.test(trimmed)) return true;

  // Mood expressions
  if (/心情(不错|很好|不好|差|烦躁|愉悦|开心|美美)/.test(trimmed)) return true;

  // Laughter / light reactions
  if (/^(哈哈|嘻嘻|嘿嘿|呵呵)/.test(trimmed)) return true;

  return false;
}

export async function loadMemoriesWithEntries(
  workingDir: string,
  query?: string,
  sessionId?: string,
): Promise<LoadMemoriesResult> {
  const entries = [
    ...loadScopedMemoryEntries(globalMemoryDir(), 'global'),
    ...loadScopedMemoryEntries(projectMemoryDir(workingDir), 'project'),
    ...loadScopedMemoryEntries(sessionMemoryDir(workingDir, sessionId), 'session'),
  ];
  if (entries.length === 0) return { content: '', entries: [] };

  // Skip memory retrieval for casual social queries (greetings, chit-chat, etc.)
  if (query?.trim() && isSocialQuery(query)) {
    return { content: '', entries: [] };
  }

  const selectedEntries = query?.trim()
    ? await searchMemories(entries, query)
    : entries.slice(0, Math.min(entries.length, MAX_RETRIEVED_MEMORIES));

  const content = formatMemoryIndex(selectedEntries);
  return { content: content.slice(0, 4000), entries: selectedEntries };
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
    scope === 'global'
      ? globalMemoryDir()
      : scope === 'project'
        ? projectMemoryDir(workingDir)
        : sessionMemoryDir(workingDir, sessionId);
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

  if (!entry.facts && provider && modelId) {
    try {
      const facts = await extractStructuredFacts(entry, provider, modelId);
      if (facts.length > 0) {
        finalEntry = { ...finalEntry, facts };
      }
    } catch (e) {
      console.warn('Failed to extract structured facts:', e);
    }
  }

  try {
    finalEntry.embedding = await computeEmbedding(finalEntry, provider, modelId);
  } catch (e) {
    console.warn('Failed to compute embedding:', e);
  }

  const sessionPath = join(memDir, `${finalEntry.date}-${finalEntry.slug}.md`);
  writeFileSync(sessionPath, formatSessionMemory(finalEntry), 'utf-8');

  await consolidateMemScenes(memDir);

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

  const queryEmbedding = await computeEmbeddingForText(query);

  const results = entries
    .map((entry) => ({ entry, score: hybridScore(entry, query, queryEmbedding) }))
    .filter((result) => result.score >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.score - a.score);

  if (results.length === 0) return [];

  return results.slice(0, MAX_RETRIEVED_MEMORIES).map((r) => r.entry);
}

export function updateMemory(
  workingDir: string,
  date: string,
  slug: string,
  updates: Partial<MemoryEntry>,
  sessionId?: string,
): void {
  const finalScope = updates.scope;
  const memDir =
    finalScope === 'global'
      ? globalMemoryDir()
      : finalScope === 'project' || !sessionId
        ? projectMemoryDir(workingDir)
        : sessionMemoryDir(workingDir, sessionId);
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
  const candidates = [
    globalMemoryDir(),
    projectMemoryDir(workingDir),
    ...(sessionId ? [sessionMemoryDir(workingDir, sessionId)] : []),
  ];
  const fileName = `${date}-${slug}.md`;

  for (const memDir of candidates) {
    const sessionPath = join(memDir, fileName);
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
      sceneCache.delete(memDir);
      rebuildIndexes(memDir);
      return;
    }
  }

  throw new Error(`Memory not found: ${date}-${slug}`);
}

export function getAllMemories(
  workingDir: string,
  sessionId?: string,
  scope?: MemoryScope,
): MemoryEntry[] {
  if (scope) {
    const memDir =
      scope === 'global'
        ? globalMemoryDir()
        : scope === 'project'
          ? projectMemoryDir(workingDir)
          : sessionMemoryDir(workingDir, sessionId);
    return loadScopedMemoryEntries(memDir, scope);
  }

  return [
    ...loadScopedMemoryEntries(globalMemoryDir(), 'global'),
    ...loadScopedMemoryEntries(projectMemoryDir(workingDir), 'project'),
    ...(sessionId
      ? loadScopedMemoryEntries(sessionMemoryDir(workingDir, sessionId), 'session')
      : []),
  ];
}

export function getMemScenes(workingDir: string, sessionId?: string): MemoryScene[] {
  const memDir = sessionId ? sessionMemoryDir(workingDir, sessionId) : projectMemoryDir(workingDir);
  return loadMemScenes(memDir);
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
  const scopeEntry =
    entries.find((entry) => entry.scope === 'global') ??
    entries.find((entry) => entry.scope === 'project') ??
    entries[0];
  const scope = scopeEntry?.scope ?? 'session';
  const memDir =
    scope === 'global'
      ? globalMemoryDir()
      : scope === 'project'
        ? projectMemoryDir(workingDir)
        : sessionMemoryDir(workingDir, sessionId);
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
    facts: [...new Set(entries.flatMap((e) => e.facts || []))],
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

async function consolidateMemScenes(memDir: string): Promise<void> {
  const scenesDir = join(memDir, MEMSCENES_DIR);
  if (!existsSync(scenesDir)) {
    mkdirSync(scenesDir, { recursive: true });
  }

  const entries = loadScopedMemoryEntries(memDir, 'session');
  const existingScenes = loadMemScenes(memDir);
  const updatedScenes = [...existingScenes];

  for (const entry of entries) {
    if (!entry.embedding || !entry.slug) continue;

    let matchedScene = null;
    let bestSimilarity = 0;

    for (const scene of updatedScenes) {
      if (!scene.centroid) continue;
      const similarity = cosineSimilarity(entry.embedding!, scene.centroid);
      if (similarity > bestSimilarity && similarity >= MEMSCENE_SIMILARITY_THRESHOLD) {
        bestSimilarity = similarity;
        matchedScene = scene;
      }
    }

    if (matchedScene) {
      if (!matchedScene.entries.includes(entry.slug)) {
        matchedScene.entries.push(entry.slug);
        matchedScene.centroid = updateCentroid(matchedScene.centroid, entry.embedding!);
        matchedScene.tags = [...new Set([...matchedScene.tags, ...(entry.tags || [])])];
        matchedScene.summary = mergeSummaries(matchedScene.summary, entry.summary);
        matchedScene.updatedAt = new Date().toISOString();
      }
    } else {
      const newScene: MemoryScene = {
        id: `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  for (const scene of updatedScenes) {
    writeFileSync(join(scenesDir, `${scene.id}.json`), JSON.stringify(scene, null, 2), 'utf-8');
  }

  const entriesToScenes: Record<string, string> = {};
  for (const scene of updatedScenes) {
    for (const entrySlug of scene.entries) {
      entriesToScenes[entrySlug] = scene.id;
    }
  }

  for (const entry of entries) {
    const entryPath = join(memDir, `${entry.date}-${entry.slug}.md`);
    if (existsSync(entryPath)) {
      const parsed = parseSessionMemory(readFileSync(entryPath, 'utf-8'));
      parsed.sceneId = entriesToScenes[entry.slug];
      writeFileSync(entryPath, formatSessionMemory(parsed), 'utf-8');
    }
  }

  sceneCache.set(memDir, updatedScenes);
}

function loadMemScenes(memDir: string): MemoryScene[] {
  const cached = sceneCache.get(memDir);
  if (cached) return cached;

  const scenesDir = join(memDir, MEMSCENES_DIR);
  if (!existsSync(scenesDir)) return [];

  const scenes: MemoryScene[] = [];
  try {
    for (const file of readdirSync(scenesDir).filter((f) => f.endsWith('.json'))) {
      const content = readFileSync(join(scenesDir, file), 'utf-8');
      const scene = JSON.parse(content) as MemoryScene;
      scenes.push(scene);
    }
  } catch {
    // Skip unreadable scene files
  }

  sceneCache.set(memDir, scenes);
  return scenes;
}

function sessionMemoryDir(workingDir: string, sessionId?: string): string {
  return getAgentDataSubdir(workingDir, MEMORIES_DIR, sessionId);
}

function globalMemoryDir(): string {
  const appDataDir = process.env.SUNCODE_APP_DATA;
  if (appDataDir) {
    return join(appDataDir, 'global', 'memories');
  }
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  return join(homeDir, '.suncode', 'global', 'memories');
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

  const factsSection =
    entry.facts && entry.facts.length > 0
      ? [
          '',
          '**结构化事实**:',
          ...entry.facts.map(
            (f) =>
              `- ${f.type}: ${f.subject} ${f.predicate} ${f.object}${f.validity.end ? ` (有效期: ${f.validity.start} ~ ${f.validity.end})` : ''}`,
          ),
        ].join('\n')
      : '';

  return [
    '---',
    `date: ${entry.date}`,
    `scope: ${entry.scope ?? 'session'}`,
    `kind: ${entry.kind ?? 'task_summary'}`,
    `importance: ${entry.importance ?? 1}`,
    `accessCount: ${entry.accessCount ?? 0}`,
    ...(entry.updatedAt ? [`updatedAt: ${entry.updatedAt}`] : []),
    ...(entry.expiresAt ? [`expiresAt: ${entry.expiresAt}`] : []),
    ...(entry.validFrom ? [`validFrom: ${entry.validFrom}`] : []),
    ...(entry.pinned ? ['pinned: true'] : []),
    ...(entry.tags && entry.tags.length > 0 ? [`tags: ${entry.tags.join(', ')}`] : []),
    ...(entry.sceneId ? [`sceneId: ${entry.sceneId}`] : []),
    ...(entry.embedding ? [`embedding: ${JSON.stringify(entry.embedding)}`] : []),
    ...(entry.facts && entry.facts.length > 0 ? [`facts: ${JSON.stringify(entry.facts)}`] : []),
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
    factsSection,
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
    validFrom: frontmatter.validFrom,
    pinned: frontmatter.pinned === 'true',
    tags: frontmatter.tags ? frontmatter.tags.split(',').map((t) => t.trim()) : [],
    sceneId: frontmatter.sceneId || undefined,
    embedding: frontmatter.embedding ? JSON.parse(frontmatter.embedding) : undefined,
    facts: frontmatter.facts ? JSON.parse(frontmatter.facts) : undefined,
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
    parts.push(`\n**Summary**: ${entry.summary || '(none)'}`);
    if (entry.facts && entry.facts.length > 0) {
      parts.push(
        `\n**Facts**: ${entry.facts
          .map((f) => `${f.subject} ${f.predicate} ${f.object}`)
          .join('; ')}`,
      );
    }
    parts.push('');
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

function hybridScore(entry: MemoryEntry, query: string, queryEmbedding: number[]): number {
  let score = 0;

  const haystack =
    `${entry.userRequest} ${entry.summary} ${(entry.tags ?? []).join(' ')}`.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (terms.length > 0) {
    const fullQuery = query.toLowerCase().trim();
    if (fullQuery && haystack.includes(fullQuery)) score += 5;
    for (const term of terms) {
      if (haystack.includes(term)) score += 2;
    }
    // For Chinese text (single token with no spaces), add character-level matching
    // so shorter substrings within the query can match relevant content
    if (terms.length === 1 && /[\u4e00-\u9fff]/.test(terms[0]!)) {
      const chars = [...terms[0]!];
      for (let i = 0; i < chars.length - 1; i++) {
        const bigram = chars[i]! + chars[i + 1]!;
        if (haystack.includes(bigram)) score += 1;
      }
    }
  }

  if (entry.embedding && queryEmbedding.length > 0) {
    const similarity = cosineSimilarity(entry.embedding, queryEmbedding);
    score += similarity * 10;
  }

  score += (entry.importance ?? 1) * 0.25;
  score += Math.min(entry.accessCount ?? 0, 10) * 0.1;
  if (entry.pinned) score += 1;

  const now = Date.now();
  const validFrom = entry.validFrom ? Date.parse(entry.validFrom) : -Infinity;
  const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : Infinity;
  if (now < validFrom || now > expiresAt) {
    score *= 0.3;
  }

  return score;
}

function memoryRetentionScore(entry: MemoryEntry): number {
  let score = (entry.importance ?? 1) * 10;
  score += Math.min(entry.accessCount ?? 0, 20);
  if (entry.pinned) score += 1000;
  if (
    entry.scope === 'global' ||
    entry.kind === 'decision' ||
    entry.kind === 'project_fact' ||
    entry.kind === 'preference'
  ) {
    score += 20;
  }
  if (entry.kind === 'ephemeral') score -= 10;

  const now = Date.now();
  const validFrom = entry.validFrom ? Date.parse(entry.validFrom) : -Infinity;
  const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : Infinity;
  if (now < validFrom || now > expiresAt) score -= 50;

  if (entry.facts && entry.facts.length > 0) {
    score += entry.facts.length * 5;
  }

  const updated = Date.parse(entry.updatedAt || entry.date || '');
  if (Number.isFinite(updated)) score += updated / 86_400_000_000;
  return score;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const minLen = Math.min(a.length, b.length);
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < minLen; i++) {
    dotProduct += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (Math.sqrt(magA) * Math.sqrt(magB));
}

function updateCentroid(current: number[], newVec: number[]): number[] {
  const result: number[] = [];
  const maxLen = Math.max(current.length, newVec.length);
  for (let i = 0; i < maxLen; i++) {
    result.push(((current[i] || 0) + (newVec[i] || 0)) / 2);
  }
  return result;
}

function mergeSummaries(existing: string, newSummary: string): string {
  if (!existing) return newSummary;
  if (!newSummary) return existing;
  const combined = `${existing}\n\n${newSummary}`;
  return combined.slice(0, MAX_SUMMARY_LENGTH);
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

async function extractStructuredFacts(
  entry: MemoryEntry,
  provider: string,
  modelId: string,
): Promise<StructuredFact[]> {
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
      console.warn('Model not available for fact extraction');
      return [];
    }

    const prompt = `请从以下会话中提取结构化事实，格式为 JSON 数组。

用户请求：${entry.userRequest}

会话摘要：${entry.summary || '(无摘要)'}

请提取以下类型的事实：
- fact: 客观事实（如"项目使用 TypeScript"）
- preference: 用户偏好（如"用户喜欢简洁的代码风格"）
- decision: 决策记录（如"决定使用 React 框架"）

每个事实包含：
- type: 类型
- subject: 主语（如"用户"、"项目"）
- predicate: 谓语（如"喜欢"、"使用"、"决定"）
- object: 宾语（如"TypeScript"、"简洁风格"）
- validity: { start: "YYYY-MM-DD", end?: "YYYY-MM-DD" } - 有效期，无截止日期则省略 end
- confidence: 0-1 的置信度

返回格式示例：
[
  {"type": "preference", "subject": "用户", "predicate": "喜欢", "object": "TypeScript", "validity": {"start": "2026-07-11"}, "confidence": 0.9},
  {"type": "fact", "subject": "项目", "predicate": "使用", "object": "Vue 3", "validity": {"start": "2026-07-11"}, "confidence": 1.0}
]

只返回 JSON 数组，不要包含其他内容。`;

    const context = {
      systemPrompt: prompt,
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    };

    const result = await complete(model, context, {
      maxTokens: 500,
      temperature: 0.2,
      signal: AbortSignal.timeout(30_000),
    });

    if (result?.content) {
      const text = result.content
        .filter(
          (c): c is { type: string; text: string } =>
            c.type === 'text' && typeof c.text === 'string',
        )
        .map((c) => c.text)
        .join('')
        .trim();

      try {
        const jsonMatch = text.match(/\[.*\]/s);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]) as StructuredFact[];
        }
      } catch (parseError) {
        console.warn('Failed to parse fact extraction JSON:', parseError);
      }
    }

    return [];
  } catch (e) {
    console.warn('Fact extraction failed:', e);
    return [];
  }
}

async function computeEmbedding(
  entry: MemoryEntry,
  provider?: string,
  modelId?: string,
): Promise<number[]> {
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

async function computeEmbeddingForText(text: string): Promise<number[]> {
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
  const normalized = text.toLowerCase();
  const features: string[] = [];
  const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(normalized);

  if (hasCJK) {
    // For CJK text: extract character unigrams, bigrams, and trigrams
    // to create meaningful multi-dimensional features without a word segmenter
    const chars = [...normalized];
    for (let i = 0; i < chars.length; i++) {
      // Character unigram
      features.push(chars[i]!);
      // Bigram
      if (i + 1 < chars.length) {
        features.push(chars[i]! + chars[i + 1]!);
      }
      // Trigram
      if (i + 2 < chars.length) {
        features.push(chars[i]! + chars[i + 1]! + chars[i + 2]!);
      }
    }
    // ASCII tokens within mixed text (e.g. "GitHub CLI" in Chinese context)
    const asciiTokens = normalized.match(/[a-z][a-z0-9_\-.]*/g) || [];
    for (const token of asciiTokens) {
      if (token.length >= 2) {
        features.push(token);
      }
    }
  } else {
    // Non-CJK text: use whitespace-separated words as before
    const words = normalized.split(/\s+/).filter(Boolean);
    for (const word of words) {
      features.push(word);
    }
  }

  // Count feature frequencies
  const counts: Record<string, number> = {};
  for (const f of features) {
    counts[f] = (counts[f] || 0) + 1;
  }

  // Sort by key for deterministic feature order
  const topFeatures = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 200);

  const embedding = topFeatures.map(([, c]) => c);
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  if (norm > 0) {
    return embedding.map((v) => v / norm);
  }

  return embedding.length > 0 ? embedding : [0];
}
