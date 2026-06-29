import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditTool } from './edit';
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

  test('edit sandbox failure retains the normalized target path', async () => {
    const dir = await makeDir();
    const outsideDir = await makeDir();
    const filePath = join(outsideDir, 'outside.ts');

    const result = await createEditTool(dir).execute({
      file_path: filePath,
      old_string: 'one',
      new_string: 'two',
    });

    expect(result.success).toBe(false);
    expect(result.details).toMatchObject({
      type: 'file_edit',
      filePath,
      status: 'failed',
      error: `Cannot edit outside working directory: ${filePath}`,
    });
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
