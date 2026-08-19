import type { Message, UiLanguage } from '@shared/types';
import { stringifyStructuredContent } from './model-structured-content';

export interface RuntimeContextInput {
  memoryContent?: string;
  relevantLessonsContent?: string;
  responseLanguage?: UiLanguage;
  currentDate?: string;
}

export function isUserAuthoredMessage(message: Message): boolean {
  return message.role === 'user' && message.contextKind === undefined;
}

export function buildRuntimeContextMessage(input: RuntimeContextInput): Message {
  const now = new Date();
  const currentDate =
    input.currentDate ??
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return {
    role: 'user',
    contextKind: 'runtime_context',
    content: stringifyStructuredContent({
      type: 'suncode.runtime_context',
      version: 1,
      snapshot: {
        memory: input.memoryContent,
        relevantLessons: input.relevantLessonsContent,
        responseLanguage: input.responseLanguage
          ? {
              language: input.responseLanguage,
              instruction: responseLanguageInstruction(input.responseLanguage),
            }
          : undefined,
        currentDate,
      },
      semantics: {
        authority: 'trusted_runtime_state',
        supersedesPriorRuntimeContext: true,
        userAuthored: false,
      },
    }),
  };
}

/** Append a changed snapshot immediately before the current user head. */
export function appendRuntimeContextIfChanged(
  messages: Message[],
  input: RuntimeContextInput,
): Message | undefined {
  const message = buildRuntimeContextMessage(input);
  const previous = [...messages]
    .reverse()
    .find((candidate) => candidate.contextKind === 'runtime_context');
  if (previous?.content === message.content) return undefined;

  let currentUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const candidate = messages[index];
    if (candidate && isUserAuthoredMessage(candidate)) {
      currentUserIndex = index;
      break;
    }
  }
  const insertionIndex = currentUserIndex >= 0 ? currentUserIndex : messages.length;
  messages.splice(insertionIndex, 0, message);
  return message;
}

function responseLanguageInstruction(language: UiLanguage): string {
  if (language === 'zh') {
    return 'Respond in Chinese for all user-facing natural language. Keep code, commands, file paths, identifiers, and quoted source text unchanged.';
  }
  return 'Respond in English for all user-facing natural language. Keep code, commands, file paths, identifiers, and quoted source text unchanged.';
}
