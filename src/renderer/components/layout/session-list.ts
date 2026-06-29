import type { SessionMeta } from '@shared/types';

export interface SessionGroup {
  path: string;
  sessions: SessionMeta[];
}

export interface VisibleSessionGroup extends SessionGroup {
  hiddenCount: number;
  totalCount: number;
}

export const DEFAULT_VISIBLE_SESSIONS_PER_GROUP = 80;

export function getVisibleSessionGroups(
  groups: SessionGroup[],
  expandedPaths: Set<string>,
  limit: number = DEFAULT_VISIBLE_SESSIONS_PER_GROUP,
): VisibleSessionGroup[] {
  return groups.map((group) => {
    const isExpanded = expandedPaths.has(group.path);
    const sessions = isExpanded ? group.sessions : group.sessions.slice(0, limit);
    return {
      path: group.path,
      sessions,
      totalCount: group.sessions.length,
      hiddenCount: Math.max(0, group.sessions.length - sessions.length),
    };
  });
}
