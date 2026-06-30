const MIN_TEXTAREA_HEIGHT = 64;
const MAX_TEXTAREA_HEIGHT = 200;

export function getComposerTextareaHeight(scrollHeight: number): number {
  return Math.min(Math.max(scrollHeight, MIN_TEXTAREA_HEIGHT), MAX_TEXTAREA_HEIGHT);
}

export function getChatInputClasses(isEmptyConversation: boolean): string[] {
  return ['chat-input', isEmptyConversation ? 'chat-input-empty' : ''].filter(Boolean);
}
