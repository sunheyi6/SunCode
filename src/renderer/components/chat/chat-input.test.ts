// @ts-expect-error Bun provides this module at test runtime; the repo has no Bun type package.
import { describe, expect, test } from 'bun:test';
import {
  getChatInputClasses,
  getComposerTextareaHeight,
  isInsideControlDropdown,
  syncChatInputDropdownBodyClass,
} from './chat-input';

describe('getComposerTextareaHeight', () => {
  test('uses the minimum height for short input', () => {
    expect(getComposerTextareaHeight(32)).toBe(64);
  });

  test('uses the content height inside the supported range', () => {
    expect(getComposerTextareaHeight(112)).toBe(112);
  });

  test('caps tall input at the maximum height', () => {
    expect(getComposerTextareaHeight(280)).toBe(200);
  });

  test('adds an empty conversation class for the floating start state', () => {
    expect(getChatInputClasses(true)).toContain('chat-input-empty');
    expect(getChatInputClasses(false)).not.toContain('chat-input-empty');
  });
});

describe('isInsideControlDropdown', () => {
  test('treats elements inside a control dropdown as internal clicks', () => {
    const item = new FakeClosestTarget(true);

    expect(isInsideControlDropdown(item)).toBe(true);
  });

  test('treats ordinary page elements as outside clicks', () => {
    const emptySpace = new FakeClosestTarget(false);

    expect(isInsideControlDropdown(emptySpace)).toBe(false);
  });
});

class FakeClosestTarget extends EventTarget {
  constructor(private readonly insideDropdown: boolean) {
    super();
  }

  closest(selector: string): unknown {
    return selector === '.control-dropdown' && this.insideDropdown ? this : null;
  }
}

describe('syncChatInputDropdownBodyClass', () => {
  test('marks the page while chat input dropdowns are open', () => {
    const classes = new FakeTokenList();

    syncChatInputDropdownBodyClass(true, classes);

    expect(classes.has('chat-input-dropdown-open')).toBe(true);
  });

  test('removes the page marker when chat input dropdowns close', () => {
    const classes = new FakeTokenList(['chat-input-dropdown-open']);

    syncChatInputDropdownBodyClass(false, classes);

    expect(classes.has('chat-input-dropdown-open')).toBe(false);
  });
});

class FakeTokenList {
  private readonly values: Set<string>;

  constructor(initialValues: string[] = []) {
    this.values = new Set(initialValues);
  }

  toggle(token: string, force: boolean): boolean {
    if (force) {
      this.values.add(token);
      return true;
    }

    this.values.delete(token);
    return false;
  }

  has(token: string): boolean {
    return this.values.has(token);
  }
}
