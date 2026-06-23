import { describe, expect, test } from 'bun:test';
import { parseNumstat } from './git-info';

describe('parseNumstat', () => {
  test('sums insertions and deletions across files', () => {
    expect(parseNumstat('12\t3\tsrc/a.ts\n5\t0\tsrc/b.ts\n')).toEqual({
      addedLines: 17,
      deletedLines: 3,
      changedFiles: 2,
    });
  });

  test('counts binary files without inventing line changes', () => {
    expect(parseNumstat('-\t-\tresources/icon.png\n2\t1\tsrc/app.ts\n')).toEqual({
      addedLines: 2,
      deletedLines: 1,
      changedFiles: 2,
    });
  });

  test('returns zeroes for clean output', () => {
    expect(parseNumstat('')).toEqual({
      addedLines: 0,
      deletedLines: 0,
      changedFiles: 0,
    });
  });
});
