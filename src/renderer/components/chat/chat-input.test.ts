// @ts-expect-error Bun provides this module at test runtime; the repo has no Bun type package.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  base64ByteLength,
  imageAttachmentDataUrl,
  MAX_IMAGE_ATTACHMENTS,
  validateImageAttachments,
} from '@shared/image-attachments';
import {
  createSessionDrafts,
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

describe('createSessionDrafts', () => {
  test('keeps unsent input isolated per session while switching conversations', () => {
    const drafts = createSessionDrafts();

    drafts.save('new-session', { text: '还没发送的内容', attachments: [] });
    drafts.save('other-session', { text: '另一个对话的草稿', attachments: [] });

    expect(drafts.load('new-session').text).toBe('还没发送的内容');
    expect(drafts.load('other-session').text).toBe('另一个对话的草稿');
  });

  test('keeps pasted images with the session draft', () => {
    const drafts = createSessionDrafts();
    const attachment = {
      id: 'image-1',
      data: 'aGVsbG8=',
      mimeType: 'image/png',
      name: 'clipboard.png',
    };

    drafts.save('session-with-image', { text: '', attachments: [attachment] });

    expect(drafts.load('session-with-image').attachments).toEqual([attachment]);
  });
});

describe('image attachment validation', () => {
  test('allows pasted data URL images in the renderer content security policy', () => {
    const indexHtml = readFileSync(new URL('../../../../index.html', import.meta.url), 'utf8');

    expect(indexHtml).toMatch(/img-src[^;]*\bdata:/);
  });

  test('computes decoded byte length without decoding image data', () => {
    expect(base64ByteLength('aGVsbG8=')).toBe(5);
  });

  test('uses the pasted bytes as the exact thumbnail and viewer source', () => {
    expect(imageAttachmentDataUrl({ data: 'iVBORw0KGgo=', mimeType: 'image/png' })).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
  });

  test('rejects more images than the composer limit', () => {
    const attachments = Array.from({ length: MAX_IMAGE_ATTACHMENTS + 1 }, (_, index) => ({
      id: `image-${index}`,
      data: 'aGVsbG8=',
      mimeType: 'image/png',
      name: `image-${index}.png`,
    }));

    expect(validateImageAttachments(attachments)).toContain(String(MAX_IMAGE_ATTACHMENTS));
  });
});
