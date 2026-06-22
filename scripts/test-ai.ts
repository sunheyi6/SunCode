// scripts/test-ai.ts
// 直接测试 pi-ai + DeepSeek API 调用，绕过 Electron
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const configPath = join(import.meta.dirname!, '..', '.suncode', 'config.json');

console.log('📁 读取配置:', configPath);
const config = JSON.parse(readFileSync(configPath, 'utf-8'));
const provider = config.activeProvider;
const modelId = config.activeModel;
const apiKey = config.envApiKeys?.[provider];

console.log('🔑 Provider:', provider);
console.log('🔑 Model:', modelId);
console.log('🔑 Key:', apiKey ? `sk-...${apiKey.slice(-4)} (长度 ${apiKey.length})` : '❌ 未设置');

if (!apiKey || apiKey.includes('在此输入')) {
  console.log('\n❌ 请先在 .suncode/config.json 中填入你的 DeepSeek API Key');
  console.log('   然后重新运行: bun run scripts/test-ai.ts');
  process.exit(1);
}

// 设置环境变量
process.env.DEEPSEEK_API_KEY = apiKey;

console.log('\n⏳ 加载 pi-ai...');
const pi = await import('@earendil-works/pi-ai');

console.log('⏳ 查找模型...');
const model = pi.getModel(provider, modelId);

if (!model) {
  console.log('❌ 模型未找到！');
  process.exit(1);
}
console.log('✅ 模型已就绪:', (model as any).id);

console.log('⏳ 调用 completeSimple...');
const start = Date.now();
const result = await pi.completeSimple(model, {
  system: '用中文回复。',
  messages: [{ role: 'user', content: '1+1等于几？' }],
});

const elapsed = Date.now() - start;
console.log(`✅ 调用成功！耗时 ${elapsed}ms`);
console.log('📝 回答:', typeof result === 'string' ? result : JSON.stringify(result).slice(0, 500));
