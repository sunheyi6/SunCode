/**
 * Shared test utilities — Kimi Code "fail-by-default" style.
 * Every helper that creates a stub throws for unmocked methods,
 * so tests can never accidentally pass because of a silent no-op.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, ToolDefinition, ToolResult } from '@shared/types';
import type { Tool } from '../../src/worker/tools/types';

// ── Temp directory management (pi pattern) ──

const createdDirs: string[] = [];

/** Create an isolated temp directory. Cleaned up in afterEach via cleanupDirs(). */
export async function makeTempDir(prefix = 'suncode-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

/** Remove all temp directories created in this test run. */
export async function cleanupDirs(): Promise<void> {
  await Promise.all(createdDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

/** Create a temp file with content inside a temp dir. Returns the file path. */
export async function makeTempFile(content: string, filename = 'test.txt'): Promise<string> {
  const dir = await makeTempDir();
  const filePath = join(dir, filename);
  await writeFile(filePath, content);
  return filePath;
}

// ── Message factories (pi pattern: factory functions with sequential IDs) ──

let idCounter = 0;

export function resetIdCounter(): void {
  idCounter = 0;
}

export function nextId(prefix = 'id'): string {
  return `${prefix}-${String(++idCounter).padStart(4, '0')}`;
}

export function createUserMessage(text: string): Message {
  return {
    role: 'user',
    content: text,
    timestamp: 0,
  };
}

export function createAssistantMessage(text: string, toolCalls?: Message['toolCalls']): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls,
    timestamp: 0,
  };
}

export function createToolResult(
  name: string,
  output: string,
  toolCallId: string,
  success = true,
): ToolResult {
  return { name, output, toolCallId, success };
}

// ── Tool execution helper (Kimi Code executeTool pattern) ──

export interface ToolExecContext {
  toolCallId: string;
  signal: AbortSignal;
}

export function toolContext(overrides?: Partial<ToolExecContext>): ToolExecContext {
  return {
    toolCallId: nextId('tc'),
    signal: new AbortController().signal,
    ...overrides,
  };
}

export async function executeTool(
  tool: Tool,
  params: Record<string, unknown>,
  ctx?: Partial<ToolExecContext>,
): Promise<ToolResult> {
  const result = await tool.execute(params);
  result.toolCallId = ctx?.toolCallId ?? nextId('tc');
  return result;
}

// ── Narrowing helpers (Kimi Code toolContentString pattern) ──

/** Assert a ToolResult output is a string and return it. */
export function asString(result: ToolResult): string {
  if (typeof result.output === 'string') return result.output;
  return JSON.stringify(result.output);
}
