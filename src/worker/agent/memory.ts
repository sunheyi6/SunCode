import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getAgentDataSubdir } from './agent-data-dir';
import { buildStructuredTaskPrompt } from './model-structured-content';

const MEMORIES_DIR = '.suncode/memories';
const MEMORY_INDEX = 'MEMORY.md';
const MEMORY_INDEX_JSON = 'MEMORY.json';
const MAX_FILES = 30;
const MAX_SUMMARY_LENGTH = 500;
const MAX_RETRIEVED_MEMORIES = 5;

export interface MemoryEntry {
  date: string;
  slug: string;
  userRequest: string;
  toolsUsed: Record<string, number>;
  summary: string;
  embedding?: number[];
  importance?: number;
  tags?: string[];
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

const embeddingCache: Map<string, number[]> = new Map();

export async function loadMemories(
  workingDir: string,
  query?: string,
  sessionId?: string,
): Promise<string> {
  const memDir = memoryDir(workingDir, sessionId);
  if (!existsSync(memDir)) return '';

  const entries = loadAllMemoryEntries(memDir);
  if (entries.length === 0) return '';

  let selectedEntries = entries;

  if (query && entries.length > 0) {
    selectedEntries = await searchMemories(entries, query);
  } else {
    selectedEntries = entries.slice(0, Math.min(entries.length, MAX_RETRIEVED_MEMORIES));
  }

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
  const memDir = memoryDir(workingDir, sessionId);
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true });
  }

  let finalEntry = entry;

  if (!entry.summary && provider && modelId) {
    try {
      const summary = await generateSummary(entry, provider, modelId);
      finalEntry = { ...entry, summary: summary.slice(0, MAX_SUMMARY_LENGTH) };
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
  const sessionContent = formatSessionMemory(finalEntry);
  writeFileSync(sessionPath, sessionContent, 'utf-8');

  pruneOldMemories(memDir);

  const indexContent = buildMemoryIndex(memDir);
  writeFileSync(join(memDir, MEMORY_INDEX), indexContent, 'utf-8');

  const jsonIndexContent = JSON.stringify(loadAllMemoryEntries(memDir), null, 2);
  writeFileSync(join(memDir, MEMORY_INDEX_JSON), jsonIndexContent, 'utf-8');
}

export async function searchMemories(
  entries: MemoryEntry[],
  query: string,
): Promise<MemoryEntry[]> {
  if (entries.length === 0 || !query.trim()) {
    return entries.slice(0, MAX_RETRIEVED_MEMORIES);
  }

  const queryEmbedding = await computeEmbedding({
    userRequest: query,
    summary: '',
    toolsUsed: {},
    date: '',
    slug: '',
  });

  const results: MemorySearchResult[] = [];
  for (const entry of entries) {
    if (!entry.embedding) {
      try {
        entry.embedding = await computeEmbedding(entry);
      } catch {
        continue;
      }
    }

    const score = cosineSimilarity(entry.embedding, queryEmbedding);
    if (score > 0.1) {
      results.push({ entry, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, MAX_RETRIEVED_MEMORIES).map((r) => r.entry);
}

export function updateMemory(
  workingDir: string,
  date: string,
  slug: string,
  updates: Partial<MemoryEntry>,
  sessionId?: string,
): void {
  const memDir = memoryDir(workingDir, sessionId);
  const sessionPath = join(memDir, `${date}-${slug}.md`);

  if (!existsSync(sessionPath)) {
    throw new Error(`Memory not found: ${date}-${slug}`);
  }

  const content = readFileSync(sessionPath, 'utf-8');
  const entry = parseSessionMemory(content);

  Object.assign(entry, updates);

  const updatedContent = formatSessionMemory(entry);
  writeFileSync(sessionPath, updatedContent, 'utf-8');

  const indexContent = buildMemoryIndex(memDir);
  writeFileSync(join(memDir, MEMORY_INDEX), indexContent, 'utf-8');

  const jsonIndexContent = JSON.stringify(loadAllMemoryEntries(memDir), null, 2);
  writeFileSync(join(memDir, MEMORY_INDEX_JSON), jsonIndexContent, 'utf-8');
}

export function deleteMemory(
  workingDir: string,
  date: string,
  slug: string,
  sessionId?: string,
): void {
  const memDir = memoryDir(workingDir, sessionId);
  const sessionPath = join(memDir, `${date}-${slug}.md`);

  if (!existsSync(sessionPath)) {
    throw new Error(`Memory not found: ${date}-${slug}`);
  }

  unlinkSync(sessionPath);

  const indexContent = buildMemoryIndex(memDir);
  writeFileSync(join(memDir, MEMORY_INDEX), indexContent, 'utf-8');

  const jsonIndexContent = JSON.stringify(loadAllMemoryEntries(memDir), null, 2);
  writeFileSync(join(memDir, MEMORY_INDEX_JSON), jsonIndexContent, 'utf-8');
}

export function getAllMemories(workingDir: string, sessionId?: string): MemoryEntry[] {
  const memDir = memoryDir(workingDir, sessionId);
  if (!existsSync(memDir)) return [];
  return loadAllMemoryEntries(memDir);
}

export function mergeMemories(
  workingDir: string,
  entries: MemoryEntry[],
  newSlug: string,
  sessionId?: string,
): void {
  const memDir = memoryDir(workingDir, sessionId);
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true });
  }

  const mergedEntry: MemoryEntry = {
    date: new Date().toISOString().split('T')[0]!,
    slug: newSlug,
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
    tags: [...new Set(entries.flatMap((e) => e.tags || []))],
  };

  for (const entry of entries) {
    const sessionPath = join(memDir, `${entry.date}-${entry.slug}.md`);
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  }

  const sessionPath = join(memDir, `${mergedEntry.date}-${mergedEntry.slug}.md`);
  const sessionContent = formatSessionMemory(mergedEntry);
  writeFileSync(sessionPath, sessionContent, 'utf-8');

  const indexContent = buildMemoryIndex(memDir);
  writeFileSync(join(memDir, MEMORY_INDEX), indexContent, 'utf-8');

  const jsonIndexContent = JSON.stringify(loadAllMemoryEntries(memDir), null, 2);
  writeFileSync(join(memDir, MEMORY_INDEX_JSON), jsonIndexContent, 'utf-8');
}

function memoryDir(workingDir: string, sessionId?: string): string {
  return getAgentDataSubdir(workingDir, MEMORIES_DIR, sessionId);
}

function formatSessionMemory(entry: MemoryEntry): string {
  const toolList = Object.entries(entry.toolsUsed)
    .map(([name, count]) => `  - ${name} ×${count}`)
    .join('\n');

  const tagList = entry.tags?.map((t) => `#${t}`).join(' ') || '';

  return [
    `---`,
    `date: ${entry.date}`,
    `importance: ${entry.importance ?? 1}`,
    ...(entry.tags && entry.tags.length > 0 ? [`tags: ${entry.tags.join(', ')}`] : []),
    ...(entry.embedding ? [`embedding: ${JSON.stringify(entry.embedding)}`] : []),
    `---`,
    '',
    `## ${entry.userRequest.slice(0, 80)}`,
    ...(tagList ? [`\n${tagList}`] : []),
    '',
    `**工具使用**:`,
    toolList || '  (无)',
    '',
    `**摘要**:`,
    entry.summary || '(无)',
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
        if (match) {
          frontmatter[match[1]!] = match[2]?.trim();
        }
      }
    }
  }

  const body = lines.slice(bodyStart).join('\n');
  const userRequestMatch = body.match(/^## (.+)$/m);
  const summaryMatch = body.match(/^\*\*摘要\*\*:\s*\n([\s\S]*?)(?:\n\n|$)/);

  const toolsUsed: Record<string, number> = {};
  const toolsMatch = body.match(/^\*\*工具使用\*\*:\s*\n([\s\S]*?)(?:\n\n|$)/);
  if (toolsMatch) {
    for (const line of (toolsMatch[1] ?? '').split('\n')) {
      const toolMatch = line.match(/^\s*-\s*([\w-]+)\s*×(\d+)/);
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
    summary: summaryMatch?.[1]?.trim() || '',
    importance: frontmatter.importance ? parseFloat(frontmatter.importance) : 1,
    tags: frontmatter.tags ? frontmatter.tags.split(',').map((t) => t.trim()) : [],
    embedding: frontmatter.embedding ? JSON.parse(frontmatter.embedding) : undefined,
  };
}

function buildMemoryIndex(memDir: string): string {
  const files = listMemoryFiles(memDir);
  if (files.length === 0) return '<!-- SunCode memory index — auto-generated -->\n';

  const parts: string[] = [
    '<!-- SunCode memory index — auto-generated -->',
    '',
    `> ${files.length} 个历史会话记录。以下是最新的 ${Math.min(files.length, 10)} 条：`,
    '',
  ];

  for (let i = 0; i < Math.min(files.length, 10); i++) {
    try {
      const content = readFileSync(join(memDir, files[i]!), 'utf-8');
      const lines = content.split('\n');
      let bodyStart = 0;
      if (lines[0]?.trim() === '---') {
        const end = lines.indexOf('---', 1);
        bodyStart = end === -1 ? 0 : end + 1;
      }
      parts.push(lines.slice(bodyStart).join('\n').trim());
    } catch {
      // Skip unreadable files
    }
  }

  return `${parts.join('\n')}\n`;
}

function formatMemoryIndex(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';

  const parts: string[] = [
    '<!-- SunCode memory index — auto-generated -->',
    '',
    `> ${entries.length} 条相关记忆：`,
    '',
  ];

  for (const entry of entries) {
    const toolList =
      Object.entries(entry.toolsUsed)
        .map(([name, count]) => `${name}×${count}`)
        .join(', ') || '无';

    const tagList = entry.tags?.map((t) => `#${t}`).join(' ') || '';

    parts.push(`## ${entry.date} - ${entry.userRequest.slice(0, 60)}`);
    if (tagList) parts.push(`\n${tagList}`);
    parts.push(`\n**工具**: ${toolList}`);
    parts.push(`\n**摘要**: ${entry.summary || '(无)'}\n`);
  }

  return parts.join('\n');
}

function pruneOldMemories(memDir: string): void {
  const files = listMemoryFiles(memDir);
  if (files.length <= MAX_FILES) return;

  for (const file of files.slice(MAX_FILES)) {
    try {
      unlinkSync(join(memDir, file!));
    } catch {
      /* skip */
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

function loadAllMemoryEntries(memDir: string): MemoryEntry[] {
  const files = listMemoryFiles(memDir);
  const entries: MemoryEntry[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(memDir, file!), 'utf-8');
      const entry = parseSessionMemory(content);
      const [date, ...slugParts] = file.replace('.md', '').split('-');
      entry.date = date;
      entry.slug = slugParts.join('-');
      entries.push(entry);
    } catch {
      // Skip unreadable files
    }
  }

  return entries;
}

async function generateSummary(
  entry: MemoryEntry,
  provider: string,
  modelId: string,
): Promise<string> {
  try {
    const { getModel, complete } = await import('@earendil-works/pi-ai');
    const model = await getModel(provider as any, modelId);
    if (!model) {
      console.warn('Model not available for summary generation');
      return '';
    }

    const prompt = `请为以下会话生成一个简洁的摘要（最多500字符），突出关键成果和经验教训：
    
用户请求：${entry.userRequest}

工具使用：${Object.entries(entry.toolsUsed)
      .map(([k, v]) => `${k}: ${v}次`)
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
      messages: [{ role: 'user' as const, content: structuredPrompt, timestamp: Date.now() }],
    };

    const result = await complete(model, context, {
      maxTokens: 300,
      temperature: 0.3,
      signal: AbortSignal.timeout(30_000),
    });

    if (result?.content) {
      const textBlocks = result.content.filter(
        (c): c is { type: 'text'; text: string } => c.type === 'text',
      );
      return textBlocks
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
    return embeddingCache.get(cacheKey)!;
  }

  const embedding = simpleTextEmbedding(text);
  embeddingCache.set(cacheKey, embedding);

  return embedding;
}

function simpleTextEmbedding(text: string): number[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const wordCounts: Record<string, number> = {};
  for (const word of words) {
    wordCounts[word] = (wordCounts[word] || 0) + 1;
  }

  const vocab = [...new Set(words)].slice(0, 100);
  const embedding: number[] = [];

  for (const word of vocab) {
    embedding.push(wordCounts[word] || 0);
  }

  const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (norm > 0) {
    return embedding.map((val) => val / norm);
  }

  return embedding.length > 0 ? embedding : [0];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    const minLen = Math.min(a.length, b.length);
    a = a.slice(0, minLen);
    b = b.slice(0, minLen);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
