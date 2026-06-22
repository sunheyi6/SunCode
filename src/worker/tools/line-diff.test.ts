// @ts-expect-error Bun provides this module at test runtime; the repo has no Bun type package.
import { describe, expect, test } from 'bun:test';
import { countLineChanges } from './line-diff';

describe('countLineChanges', () => {
  test('counts all lines in a new file as additions', () => {
    expect(countLineChanges('', 'one\ntwo\n')).toEqual({ addedLines: 2, removedLines: 0 });
  });

  test('counts a changed line as one removal and one addition', () => {
    expect(countLineChanges('one\ntwo\nthree', 'one\nTWO\nthree')).toEqual({
      addedLines: 1,
      removedLines: 1,
    });
  });

  test('counts inserted and deleted lines around unchanged lines', () => {
    expect(countLineChanges('a\nb\nc\nd', 'a\nx\nc\ny')).toEqual({
      addedLines: 2,
      removedLines: 2,
    });
  });

  test('treats empty text as zero lines', () => {
    expect(countLineChanges('', '')).toEqual({ addedLines: 0, removedLines: 0 });
  });

  test('ignores one trailing line break when counting logical lines', () => {
    expect(countLineChanges('a\nb', 'a\nb\n')).toEqual({ addedLines: 0, removedLines: 0 });
  });

  test('counts every old line as removed when the new content is empty', () => {
    expect(countLineChanges('one\ntwo\n', '')).toEqual({ addedLines: 0, removedLines: 2 });
  });

  test('normalizes CRLF before comparing lines', () => {
    expect(countLineChanges('one\r\ntwo\r\n', 'one\ntwo\n')).toEqual({
      addedLines: 0,
      removedLines: 0,
    });
  });

  test('finds an exact shortest edit with duplicate lines', () => {
    expect(countLineChanges('a\nb\na\nc', 'a\na\nb\nc')).toEqual({
      addedLines: 1,
      removedLines: 1,
    });
  });

  test('uses bounded work for large unrelated inputs', () => {
    const oldContent = Array.from({ length: 50_000 }, (_, index) => `old-${index}`).join('\n');
    const newContent = Array.from({ length: 50_000 }, (_, index) => `new-${index}`).join('\n');

    expect(countLineChanges(oldContent, newContent, { maxWork: 1 })).toEqual({
      addedLines: 50_000,
      removedLines: 50_000,
    });
  });

  test('keeps exact counts when bounded Myers work leaves matching middle lines', () => {
    const sharedLines = Array.from({ length: 100 }, (_, index) => `shared-${index}`);
    const oldContent = [
      ...Array.from({ length: 1_000 }, (_, index) => `old-before-${index}`),
      ...sharedLines,
      ...Array.from({ length: 1_000 }, (_, index) => `old-after-${index}`),
    ].join('\n');
    const newContent = [
      ...Array.from({ length: 1_000 }, (_, index) => `new-before-${index}`),
      ...sharedLines,
      ...Array.from({ length: 1_000 }, (_, index) => `new-after-${index}`),
    ].join('\n');

    expect(countLineChanges(oldContent, newContent, { maxWork: 1 })).toEqual({
      addedLines: 2_000,
      removedLines: 2_000,
    });
  });
});
