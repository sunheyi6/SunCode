import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from '../src/worker/agent/agent';
import type { AppSettings, Message, RunEvent, StreamEvent, ToolCallContent, ToolResult } from '../src/shared/types';

const prompt = `实现一个 MIPS 解释器，给定如下汇编代码，分步执行，输出最终寄存器 v0 的值；执行过程中如果结果错误，对照每一步内存、寄存器日志定位 bug 并修改汇编代码。
附上固定长 MIPS 汇编源码：
# 功能：计算 10! (10的阶乘)，内置两处bug，执行后v0结果错误，需要分步日志回溯定位修复
.data
nums: .word 1,2,3,4,5,6,7,8,9,10
result_buf: .space 4

.text
main:
    li $t0, 0        # 数组下标i
    li $t1, 10       # 数组长度上限
    li $t2, 1        # 阶乘初始值
loop:
    bge $t0, $t1, exit_loop  # i >= 10 跳出循环
    # 读取nums[i]
    lw $t3, nums($t0)
    mul $t2, $t2, $t3        # fact = fact * nums[i]
    addi $t0, $t0, 1
    j loop
exit_loop:
    sw $t2, result_buf($zero)
    # Bug1：lw读取偏移写错，正确应为0，这里写成4，读成第二个数字
    lw $v0, result_buf(4)
    # Bug2：缺少系统调用退出，无输出终止指令
    jr $ra`;

const config = JSON.parse(readFileSync(join(process.cwd(), '.suncode', 'config.json'), 'utf-8'));
const settings: AppSettings = {
  ...config,
  maxTurns: 50,
  permissionMode: 'full_access',
};

const envKeyMap: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
};
const envKey = envKeyMap[settings.activeProvider];
const apiKey = settings.envApiKeys?.[settings.activeProvider];
if (envKey && apiKey) process.env[envKey] = apiKey;

const workingDir = join(process.cwd(), '.tmp', `mips-smoke-${Date.now()}`);
mkdirSync(workingDir, { recursive: true });

let finalMessage: Message | null = null;
let currentText = '';
let currentThinking = '';
const runEvents: RunEvent[] = [];

const agent = new Agent(
  workingDir,
  settings,
  (event: StreamEvent) => {
    if (event.type === 'turn_start') {
      console.log(`[turn ${event.turnCount}/${event.maxTurns}] start`);
    }
    if (event.type === 'text_delta') currentText += event.text || '';
    if (event.type === 'thinking_delta') currentThinking += event.text || '';
  },
  (status) => {
    console.log(`[status] ${status.state} turn=${status.turnCount}`);
  },
  (toolCall: ToolCallContent) => {
    console.log(`[tool:start] ${toolCall.name} ${toolCall.id}`);
  },
  (result: ToolResult) => {
    console.log(
      `[tool:end] ${result.name} ${result.success ? 'ok' : `fail ${result.error || ''}`}`,
    );
  },
  (message: Message) => {
    finalMessage = message;
  },
  (error) => {
    console.error(`[error] ${error}`);
  },
  () => {},
  () => {},
  (event) => {
    runEvents.push(event);
    if (event.type === 'run_completed') {
      console.log(`[run] completed turns=${event.turnCount}`);
    }
  },
  () => {},
);

await new Promise((resolve) => setTimeout(resolve, 1500));
await agent.prompt(prompt);

const text = finalMessage ? extractText(finalMessage) : '';
console.log('\n=== STREAM TEXT TAIL ===');
console.log(currentText.slice(-2000));
console.log('\n=== THINKING CHARS ===');
console.log(currentThinking.length);
console.log('\n=== FINAL TEXT ===');
console.log(text);
console.log('\n=== RUN EVENTS ===');
console.log(runEvents.map((event) => event.type).join(', '));

function extractText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? block.text : ''))
    .join('');
}
