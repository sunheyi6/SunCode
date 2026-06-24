/**
 * 快速测试 SubagentDispatcher 独立运行（无需 Electron）
 * 运行: bun run scripts/test-subagent.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 读取配置
const configPath = join(import.meta.dirname!, '..', '.suncode', 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));
const apiKey = config.envApiKeys?.[config.activeProvider];
if (!apiKey) {
  console.log('❌ 请先在 .suncode/config.json 中配置 API Key');
  process.exit(1);
}

// 设置环境变量
const envKeyMap: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY',
};
const envKey = envKeyMap[config.activeProvider];
if (envKey) process.env[envKey] = apiKey;

// 动态导入
const { SubagentDispatcher } = await import('../src/worker/agent/subagent.js');

const dispatcher = new SubagentDispatcher(
  new Map([
    ['explore', {
      name: 'explore',
      description: '代码库探索专家',
      systemPrompt: '你是代码库探索专家。使用 read、grep、glob 查找相关文件、符号和测试。返回简洁发现，包含文件路径和行号引用。不要修改任何文件。',
      tools: ['read', 'grep', 'glob'],
      maxTurns: 5,
    }],
  ]),
  {
    settings: config,
    workingDir: process.cwd(),
    parentMessages: [],
    parentSessionId: 'test',
    abortSignal: new AbortController().signal,
    depth: 0,
    ancestorStack: [],
    onSubagentStart: (e) => console.log('  🚀 启动:', e.agent, '—', e.prompt.slice(0, 60)),
    onSubagentEnd: (_id, r) => console.log('  ✅ 完成:', r.agent, r.success ? `输出 ${r.output.length} 字符, ${r.tokenUsage.total} tokens` : `失败: ${r.error}`),
  },
);

const task = process.argv[2] || '查找 src/main/ipc-handlers.ts 中所有 session 相关的 IPC handler';

console.log('📋 测试任务:', task);
console.log('⏳ 执行中...\n');

const results = await dispatcher.dispatch([{
  agent: 'explore',
  prompt: task,
}]);

console.log('\n--- 结果 ---');
for (const r of results) {
  console.log(`[${r.agent}] ${r.success ? '✅' : '❌'}`);
  console.log(`  Tokens: ${r.tokenUsage.total}  |  工具调用: ${r.toolCalls}`);
  console.log(`  输出: ${r.output.slice(0, 500)}`);
  if (r.error) console.log(`  错误: ${r.error}`);
}
