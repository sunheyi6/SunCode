const MIN_TEXTAREA_HEIGHT = 64;
const MAX_TEXTAREA_HEIGHT = 200;
export const COLLAPSED_TEXTAREA_HEIGHT = 120;
const DROPDOWN_OPEN_BODY_CLASS = 'chat-input-dropdown-open';

export interface SessionDrafts {
  load: (sessionId: string | null) => string;
  save: (sessionId: string | null, text: string) => void;
}

export function createSessionDrafts(): SessionDrafts {
  const drafts = new Map<string, string>();

  return {
    load(sessionId) {
      if (!sessionId) return '';
      return drafts.get(sessionId) ?? '';
    },
    save(sessionId, text) {
      if (!sessionId) return;
      if (text.length === 0) {
        drafts.delete(sessionId);
        return;
      }
      drafts.set(sessionId, text);
    },
  };
}

export const chatInputSessionDrafts = createSessionDrafts();

export function getComposerTextareaHeight(scrollHeight: number): number {
  return Math.min(Math.max(scrollHeight, MIN_TEXTAREA_HEIGHT), MAX_TEXTAREA_HEIGHT);
}

export function getChatInputClasses(isEmptyConversation: boolean): string[] {
  return ['chat-input', isEmptyConversation ? 'chat-input-empty' : ''].filter(Boolean);
}

type ClosestCapableTarget = EventTarget & {
  closest: (selector: string) => unknown;
};

interface ToggleClassList {
  toggle: (token: string, force: boolean) => boolean;
}

function hasClosest(target: EventTarget | null): target is ClosestCapableTarget {
  return typeof (target as Partial<ClosestCapableTarget> | null)?.closest === 'function';
}

export function isInsideControlDropdown(target: EventTarget | null): boolean {
  if (hasClosest(target)) {
    return target.closest('.control-dropdown') !== null;
  }

  if (typeof Node !== 'undefined' && target instanceof Node) {
    return target.parentElement?.closest('.control-dropdown') !== null;
  }

  return false;
}

export function syncChatInputDropdownBodyClass(isOpen: boolean, classList: ToggleClassList): void {
  classList.toggle(DROPDOWN_OPEN_BODY_CLASS, isOpen);
}
