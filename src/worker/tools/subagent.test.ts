import type { SubagentCall, SubagentResult } from '@shared/types';
import { describe, expect, test } from 'vitest';
import type { SubagentDispatcher } from '../agent/subagent';
import { createSubagentTool } from './subagent';

const LONG_OUTPUT = 'x'.repeat(2000);
const LONG_ERROR = 'e'.repeat(500);

function makeDispatcher(results: SubagentResult[]): SubagentDispatcher {
  return {
    listAgents: () => ['explore'],
    getDefinition: (name: string) =>
      name === 'explore'
        ? { name: 'explore', description: 'x', systemPrompt: 'x', tools: [] }
        : undefined,
    dispatch: async (calls: SubagentCall[]) => calls.map((_, i) => results[i] ?? results[0]),
  } as unknown as SubagentDispatcher;
}

function result(overrides: Partial<SubagentResult>): SubagentResult {
  return {
    agent: 'explore',
    success: true,
    output: '结论',
    toolCalls: 3,
    tokenUsage: { input: 100, output: 50, total: 150 },
    ...overrides,
  };
}

describe('subagent tool result summary', () => {
  test('short output is kept in full and exposes the archive path', async () => {
    const tool = createSubagentTool(
      makeDispatcher([result({ output: '短结论', fullOutputPath: 'D:\\tmp\\archive.txt' })]),
    );
    const res = await tool.execute({ agent: 'explore', prompt: '任务' });

    expect(res.success).toBe(true);
    expect(res.output).toContain('1/1 子 Agent 成功完成');
    expect(res.output).toContain('短结论');
    expect(res.output).toContain('archive.txt');
  });

  test('long output is truncated with an on-demand read hint', async () => {
    const tool = createSubagentTool(
      makeDispatcher([result({ output: LONG_OUTPUT, fullOutputPath: 'D:\\tmp\\long.txt' })]),
    );
    const res = await tool.execute({ agent: 'explore', prompt: '任务' });

    expect(res.success).toBe(true);
    expect(res.output.length).toBeLessThan(LONG_OUTPUT.length);
    expect(res.output).toContain('已截断');
    expect(res.output).toContain('long.txt');
  });

  test('failed subagent reports a bounded error summary', async () => {
    const tool = createSubagentTool(
      makeDispatcher([result({ success: false, output: '', error: LONG_ERROR })]),
    );
    const res = await tool.execute({ agent: 'explore', prompt: '任务' });

    expect(res.success).toBe(false);
    expect(res.output).toContain('0/1 子 Agent 成功完成');
    expect(res.output).toContain('已截断');
    expect(res.output.length).toBeLessThan(LONG_ERROR.length + 200);
  });

  test('unknown agent is rejected before dispatch', async () => {
    const tool = createSubagentTool(makeDispatcher([]));
    const res = await tool.execute({ agent: 'nope', prompt: '任务' });

    expect(res.success).toBe(false);
    expect(res.error).toContain('未知的 Agent');
  });

  test('missing agent and prompt returns a parameter error', async () => {
    const tool = createSubagentTool(makeDispatcher([]));
    const res = await tool.execute({});

    expect(res.success).toBe(false);
    expect(res.error).toContain('参数错误');
  });

  test('batch calls summarize each item independently', async () => {
    const tool = createSubagentTool(
      makeDispatcher([
        result({ output: 'A 的结论', fullOutputPath: 'D:\\tmp\\a.txt' }),
        result({ success: false, output: '', error: 'B 失败了' }),
      ]),
    );
    const res = await tool.execute({
      calls: [
        { agent: 'explore', prompt: '任务A' },
        { agent: 'explore', prompt: '任务B' },
      ],
    });

    expect(res.success).toBe(true);
    expect(res.output).toContain('1/2 子 Agent 成功完成');
    expect(res.output).toContain('A 的结论');
    expect(res.output).toContain('B 失败了');
  });

  test('partial subagent reports completed progress and a take-over hint', async () => {
    const tool = createSubagentTool(
      makeDispatcher([
        result({
          status: 'partial',
          success: false,
          output: '',
          toolCalls: 3,
          partialProgress: '已完成 3 次工具调用（read×2、grep×1），涉及文件：a.ts',
          error: '子 Agent 已超过 20 次工具调用预算',
        }),
      ]),
    );
    const res = await tool.execute({ agent: 'explore', prompt: '任务' });

    // Partial counts as usable progress, not as a plain failure.
    expect(res.success).toBe(true);
    expect(res.output).toContain('1/1 子 Agent 成功完成');
    expect(res.output).toContain('部分完成');
    expect(res.output).toContain('a.ts');
    expect(res.output).toContain('重新派发');
  });
});
