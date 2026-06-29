import { describe, expect, test } from 'vitest';
import { getVisibleSessionGroups } from '../../src/renderer/components/layout/session-list';
import type { SessionMeta } from '../../src/shared/types';

function session(id: string): SessionMeta {
  return {
    id,
    name: id,
    created: '2026-06-29T12:00:00.000Z',
    updated: '2026-06-29T12:00:00.000Z',
    messageCount: 1,
    workingDirectory: 'D:\\project\\SunCode',
  };
}

describe('getVisibleSessionGroups', () => {
  test('limits collapsed groups and reports hidden sessions', () => {
    const groups = [
      {
        path: 'D:\\project\\SunCode',
        sessions: Array.from({ length: 5 }, (_, index) => session(`session-${index}`)),
      },
    ];

    const visible = getVisibleSessionGroups(groups, new Set(), 2);

    expect(visible[0]?.sessions.map((item) => item.id)).toEqual(['session-0', 'session-1']);
    expect(visible[0]?.hiddenCount).toBe(3);
    expect(visible[0]?.totalCount).toBe(5);
  });

  test('returns all sessions for expanded groups', () => {
    const groups = [
      {
        path: 'D:\\project\\SunCode',
        sessions: Array.from({ length: 3 }, (_, index) => session(`session-${index}`)),
      },
    ];

    const visible = getVisibleSessionGroups(groups, new Set(['D:\\project\\SunCode']), 1);

    expect(visible[0]?.sessions).toHaveLength(3);
    expect(visible[0]?.hiddenCount).toBe(0);
  });
});
