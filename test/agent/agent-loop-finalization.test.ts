import { describe, expect, it } from 'vitest';
import { isIncompleteProgressText } from '../../src/shared/finalization';

describe('agent loop finalization guards', () => {
  it('detects unfinished progress text as not final', () => {
    expect(
      isIncompleteProgressText(
        '修复解释器 + 重新运行。现在我需要在修复后的第一遍中处理标签同行伪指令，并添加 add 指令支持，然后重跑。',
      ),
    ).toBe(true);

    expect(isIncompleteProgressText('设置 UTF-8 环境变量再运行：')).toBe(true);
    expect(
      isIncompleteProgressText('文件编码有问题，我直接用 ASCII 重写整个文件，避免所有 Unicode 问题：'),
    ).toBe(true);
    expect(
      isIncompleteProgressText(
        '问题是 `.word` 后如果有逗号连在一起的数字，会被当作单个 token。需要按逗号分割所有参数：',
      ),
    ).toBe(true);
  });

  it('allows complete answers with verification evidence', () => {
    expect(
      isIncompleteProgressText(
        '最终结果：$v0 = 3628800。验证：修复后的解释器重新运行通过，10! 的结果与预期一致。',
      ),
    ).toBe(false);
  });
});
