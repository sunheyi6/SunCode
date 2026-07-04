import { describe, expect, it } from 'vitest';
import {
  isIncompleteProgressText,
  sanitizeStructuredMessageLeak,
  sanitizeStructuredMessageLeakStreaming,
} from '../../src/shared/finalization';

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

  it('unwraps a structured assistant message leaked as final text', () => {
    const leaked = JSON.stringify(
      {
        type: 'suncode.message',
        version: 1,
        role: 'assistant',
        content: { text: '已完成，运行结果是 hello world。' },
      },
      null,
      2,
    );

    expect(sanitizeStructuredMessageLeak(leaked)).toBe('已完成，运行结果是 hello world。');
  });

  it('recovers text from a malformed structured assistant message leak', () => {
    const leaked = `{
  "type": "suncode.message",
  "version": 1,
  "role": "assistant",
  "content": {
    "text": "完成，输出 hello world。"

   ]
  }
}`;

    expect(sanitizeStructuredMessageLeak(leaked)).toBe('完成，输出 hello world。');
  });
});

describe('sanitizeStructuredMessageLeakStreaming', () => {
  const ENVELOPE_HEAD =
    '{\n  "type": "suncode.message",\n  "version": 1,\n  "role": "assistant",\n  "content": {\n    "text": "';

  it('hides the envelope prefix before the text value arrives', () => {
    const partial =
      '{\n  "type": "suncode.message",\n  "version": 1,\n  "role": "assistant",\n  "content": {';
    expect(sanitizeStructuredMessageLeakStreaming(partial)).toBe('');
  });

  it('extracts the inner text once the text value closes (no closing braces yet)', () => {
    const partial =
      ENVELOPE_HEAD +
      '找到了 workspace 数据目录：`%APPDATA%/<app>/workspaces/default`。让我找到实际路径并查看最新的会话。"';
    expect(sanitizeStructuredMessageLeakStreaming(partial)).toBe(
      '找到了 workspace 数据目录：`%APPDATA%/<app>/workspaces/default`。让我找到实际路径并查看最新的会话。',
    );
  });

  it('extracts partial text while the text value is still being emitted', () => {
    const partial = ENVELOPE_HEAD + '找到了 workspace 数据目录';
    expect(sanitizeStructuredMessageLeakStreaming(partial)).toBe('找到了 workspace 数据目录');
  });

  it('ignores trailing braces after the text value closes', () => {
    const partial = ENVELOPE_HEAD + '完成了。"\n  }\n}';
    expect(sanitizeStructuredMessageLeakStreaming(partial)).toBe('完成了。');
  });

  it('passes through plain text without an envelope unchanged', () => {
    const plain = '这是一段普通的助手回复，没有信封。';
    expect(sanitizeStructuredMessageLeakStreaming(plain)).toBe(plain);
  });

  it('decodes escape sequences inside the streamed text value', () => {
    // JSON text value contains escapes: \n (newline), \" (quote), \\ (backslash).
    const partial = ENVELOPE_HEAD + '第一行\\n第二行\\"引号\\\\end';
    expect(sanitizeStructuredMessageLeakStreaming(partial)).toBe('第一行\n第二行"引号\\end');
  });

  it('matches the finalize variant once the envelope is complete', () => {
    const complete = JSON.stringify(
      {
        type: 'suncode.message',
        version: 1,
        role: 'assistant',
        content: { text: '完整信封，应与 finalize 结果一致。' },
      },
      null,
      2,
    );
    expect(sanitizeStructuredMessageLeakStreaming(complete)).toBe(
      sanitizeStructuredMessageLeak(complete),
    );
  });
});