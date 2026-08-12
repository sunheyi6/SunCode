import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildTrustedVisionObservation, isPureVisionQuestion } from '../models/vision-routing';
import { createEditTool } from './edit';
import { createFindTool } from './find';
import { createGlobTool } from './glob';
import { createGrepTool } from './grep';
import { buildVisionContext } from './inspect-image';
import { createLsTool } from './ls';
import { createReadTool } from './read';
import { createWriteTool } from './write';

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'suncode-tools-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('file tool details', () => {
  test('edit reports the path and changed line counts', async () => {
    const dir = await makeDir();
    const filePath = join(dir, 'sample.ts');
    await writeFile(filePath, 'one\ntwo\nthree\n');

    const result = await createEditTool(dir).execute({
      file_path: filePath,
      old_string: 'two',
      new_string: 'TWO',
    });

    expect(result.details).toMatchObject({
      type: 'file_edit',
      filePath,
      status: 'edited',
      addedLines: 1,
      removedLines: 1,
    });
  });

  test('edit failure retains the target path and reason', async () => {
    const dir = await makeDir();
    const filePath = join(dir, 'sample.ts');
    await writeFile(filePath, 'one\n');

    const result = await createEditTool(dir).execute({
      file_path: filePath,
      old_string: 'missing',
      new_string: 'replacement',
    });

    expect(result.success).toBe(false);
    expect(result.details).toMatchObject({
      type: 'file_edit',
      filePath,
      status: 'failed',
      error: expect.stringContaining('Could not find'),
    });
  });

  test('edit can modify a file outside the working directory', async () => {
    const dir = await makeDir();
    const outsideDir = await makeDir();
    const filePath = join(outsideDir, 'outside.ts');
    await writeFile(filePath, 'one');

    const result = await createEditTool(dir).execute({
      file_path: filePath,
      old_string: 'one',
      new_string: 'two',
    });

    expect(result.success).toBe(true);
    expect(await readFile(filePath, 'utf-8')).toBe('two');
    expect(result.details).toMatchObject({
      type: 'file_edit',
      filePath,
      status: 'edited',
    });
  });

  test('read and discovery tools can access sensitive files outside the working directory', async () => {
    const dir = await makeDir();
    const outsideDir = await makeDir();
    const filePath = join(outsideDir, '.env');
    await writeFile(filePath, 'EXTERNAL_TOKEN=visible');

    const readResult = await createReadTool(dir).execute({ file_path: filePath });
    const findResult = await createFindTool(dir).execute({ path: outsideDir, pattern: '.env' });
    const globResult = await createGlobTool(dir).execute({ path: outsideDir, pattern: '*.env' });
    const grepResult = await createGrepTool(dir).execute({
      path: outsideDir,
      pattern: 'EXTERNAL_TOKEN',
    });
    const lsResult = await createLsTool(dir).execute({ path: outsideDir });

    for (const result of [readResult, findResult, globResult, grepResult, lsResult]) {
      expect(result.success).toBe(true);
    }
    expect(readResult.output).toContain('EXTERNAL_TOKEN=visible');
  });

  test('read does not inject image base64 into the model context', async () => {
    const dir = await makeDir();
    const filePath = join(dir, 'screen.png');
    await writeFile(filePath, Buffer.from('fake-image-bytes'));

    const result = await createReadTool(dir).execute({ file_path: filePath });

    expect(result.success).toBe(true);
    expect(result.output).toContain('inspect_image');
    expect(result.output).toContain('not added to the main model context');
    expect(result.output).not.toContain(Buffer.from('fake-image-bytes').toString('base64'));
  });

  test('vision request is isolated from the main agent context', () => {
    const context = buildVisionContext('读取错误提示', [
      { type: 'image', data: 'image-base64', mimeType: 'image/png' },
    ]);

    expect(context.messages).toHaveLength(1);
    expect(context.tools).toEqual([]);
    expect(context.messages[0].content).toEqual([
      { type: 'text', text: '读取错误提示' },
      { type: 'image', data: 'image-base64', mimeType: 'image/png' },
    ]);
  });

  test('marks vision observations as trusted evidence for the main model', () => {
    const observation = buildTrustedVisionObservation(
      '这是 Viewer.js 的 GitHub 仓库页面。',
      'opencode-go',
      'qwen3.6-plus',
    );

    expect(observation).toContain('<vision_observation');
    expect(observation).toContain('provider="opencode-go"');
    expect(observation).toContain('这是 Viewer.js 的 GitHub 仓库页面。');
  });

  test('routes only pure visual questions through the direct vision path', () => {
    expect(isPureVisionQuestion('这个图片展示的是什么内容？')).toBe(true);
    expect(isPureVisionQuestion('请读取截图上的错误文字')).toBe(true);
    expect(isPureVisionQuestion('')).toBe(true);
    expect(isPureVisionQuestion('根据这张截图修改页面布局')).toBe(false);
    expect(isPureVisionQuestion('分析截图中的报错并修复代码')).toBe(false);
  });

  test('glob matches files at every depth after a recursive wildcard', async () => {
    const dir = await makeDir();
    await writeFile(join(dir, 'root.ts'), 'root');
    const nestedDir = join(dir, 'nested');
    await mkdir(nestedDir);
    await writeFile(join(nestedDir, 'child.ts'), 'child');

    const result = await createGlobTool(dir).execute({ pattern: '**/*.ts' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('root.ts');
    expect(result.output).toContain('nested');
    expect(result.output).toContain('child.ts');
  });

  test('grep uses the built-in scanner when external search commands are unavailable', async () => {
    const dir = await makeDir();
    const nestedDir = join(dir, 'nested');
    await mkdir(nestedDir);
    await writeFile(join(nestedDir, 'sample.ts'), 'const searchableValue = true;\n');
    const result = await createGrepTool(dir, {
      shell: { path: 'unused', type: 'powershell' },
      env: { PATH: '' },
    }).execute({
      pattern: 'searchableValue',
      glob: '**/*.ts',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('used built-in scan');
    expect(result.output).toContain('nested/sample.ts:1');
  });

  test('write can create a file outside the working directory', async () => {
    const dir = await makeDir();
    const outsideDir = await makeDir();
    const filePath = join(outsideDir, '.env');

    const result = await createWriteTool(dir).execute({
      file_path: filePath,
      content: 'EXTERNAL_TOKEN=written',
    });

    expect(result.success).toBe(true);
    expect(await readFile(filePath, 'utf-8')).toBe('EXTERNAL_TOKEN=written');
  });

  test('write reports all lines when creating a file', async () => {
    const dir = await makeDir();
    const filePath = join(dir, 'created.ts');
    const result = await createWriteTool(dir).execute({
      file_path: filePath,
      content: 'one\ntwo\n',
    });

    expect(await readFile(filePath, 'utf-8')).toBe('one\ntwo\n');
    expect(result.details).toMatchObject({
      type: 'file_edit',
      filePath,
      status: 'edited',
      addedLines: 2,
      removedLines: 0,
    });
  });

  test('write compares old and replacement content', async () => {
    const dir = await makeDir();
    const filePath = join(dir, 'replaced.ts');
    await writeFile(filePath, 'one\ntwo\n');

    const result = await createWriteTool(dir).execute({
      file_path: filePath,
      content: 'one\nthree\n',
    });

    expect(result.details).toMatchObject({ addedLines: 1, removedLines: 1 });
  });

  test('write validation failure retains a known target path', async () => {
    const dir = await makeDir();
    const filePath = join(dir, 'missing-content.ts');

    const result = await createWriteTool(dir).execute({ file_path: filePath });

    expect(result.success).toBe(false);
    expect(result.details).toMatchObject({
      type: 'file_edit',
      filePath,
      status: 'failed',
      error: 'content is required',
    });
  });
});
