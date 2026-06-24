/**
 * 完整测试子 Agent 数据流：dispatch → SubagentResult → ToolResult
 * bun run scripts/test-subagent-full.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const configPath = join(import.meta.dirname!, '..', '.suncode', 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));
const apiKey = config.envApiKeys?.[config.activeProvider];
if (!apiKey) { console.log('❌ 请先配置 API Key'); process.exit(1); }

const envKeyMap: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY',
};
if (envKeyMap[config.activeProvider]) process.env[envKeyMap[config.activeProvider]] = apiKey;

const { SubagentDispatcher } = await import('../src/worker/agent/subagent.js');
const { createSubagentTool } = await import('../src/worker/tools/subagent.js');

// ── 创建 dispatcher ──
const defs = new Map([
  ['explore', {
    name: 'explore', description: '探索', systemPrompt: '你是探索专家。用 read/grep/glob 找到答案。回复简洁，包含文件路径。',
    tools: ['read', 'grep', 'glob'], maxTurns: 5,
  }],
]);

const dispatcher = new SubagentDispatcher(defs, {
  settings: config,
  workingDir: process.cwd(),
  parentMessages: [],
  parentSessionId: 'test',
  abortSignal: new AbortController().signal,
  depth: 0,
  ancestorStack: [],
  callbacks: {
    onStream: () => {},
    onToolStart: (tc) => console.log('  [ToolStart]', tc.name),
    onToolEnd: (r) => console.log('  [ToolEnd]', r.name, r.success ? 'OK' : `FAIL: ${r.error}`),
    onRunEvent: () => {},
    onSubagentStart: (e) => console.log('  [SubagentStart]', e.agent),
    onSubagentEnd: (id, r) => console.log('  [SubagentEnd]', r.agent, `think=${r.thinking?.length ?? 0}`, `calls=${r.internalCalls?.length ?? 0}`),
  },
});

// ── 创建 subagent 工具 ──
const tool = createSubagentTool(dispatcher);

// ── 测试 1：验证工具参数格式 ──
console.log('\n=== 测试 1：单次调用 { agent, prompt } ===');
const result1 = await tool.execute({
  agent: 'explore',
  prompt: '列出 src/main/ 目录下的所有 .ts 文件，说出每个文件的用途。只读，不修改任何文件。',
});
console.log('success:', result1.success);
console.log('output:', result1.output.slice(0, 300));
console.log('subagentResults:', result1.subagentResults?.length, 'items');
if (result1.subagentResults?.[0]) {
  const r = result1.subagentResults[0];
  console.log('  agent:', r.agent);
  console.log('  thinking:', r.thinking?.length ?? 0, 'chars');
  console.log('  internalCalls:', r.internalCalls?.length ?? 0, 'calls');
  if (r.internalCalls && r.internalCalls.length > 0) {
    for (const tc of r.internalCalls) {
      console.log('    -', tc.name, tc.status, tc.result?.success ? 'OK' : '?');
    }
  }
  console.log('  output:', r.output?.slice(0, 200));
}

// ── 测试 2：并行调用 { calls: [...] } ──
console.log('\n=== 测试 2：并行调用 ===');
const result2 = await tool.execute({
  calls: [
    { agent: 'explore', prompt: '查看 src/renderer/stores/ 目录结构，列出所有 store 文件' },
    { agent: 'explore', prompt: '查看 src/worker/agent/ 目录结构，列出所有 agent 相关文件' },
  ],
});
console.log('success:', result2.success);
console.log('subagentResults:', result2.subagentResults?.length, 'items');
for (const r of result2.subagentResults ?? []) {
  console.log(`  [${r.agent}] output=${r.output.length}chars think=${r.thinking?.length ?? 0} calls=${r.internalCalls?.length ?? 0}`);
}

console.log('\n=== 测试完成 ===');
