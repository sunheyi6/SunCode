import { createHash } from 'node:crypto';
import type { Message } from '@shared/types';
import { estimateMessagesTokens } from './context-budget';

export interface SemanticProjectionState {
  objective: string;
  constraints: string[];
  completedWork: string[];
  currentState: string[];
  decisions: string[];
  failedApproaches: string[];
  unresolvedWork: string[];
  nextAction: string;
}

export interface SemanticProjection {
  id: string;
  previousProjectionId?: string;
  headDigest: string;
  sourceDigest: string;
  estimatedTokens: number;
  state: SemanticProjectionState;
}

export interface SemanticCompactCandidate {
  headIndex: number;
  sourceStartIndex: number;
  sourceEndIndex: number;
  beforeTokens: number;
  newlyCompletedTokens: number;
  previousProjectionId?: string;
  sourceMessages: Message[];
}

export interface SemanticCompactEligibility {
  candidate?: SemanticCompactCandidate;
  reason?: 'head_missing' | 'below_pressure' | 'insufficient_new_history';
}

export function selectSemanticCompactCandidate(input: {
  messages: Message[];
  headAnchor: Message;
  contextWindow: number;
  threshold: number;
  minNewTokens: number;
  shadowCoveredThrough?: Message;
}): SemanticCompactEligibility {
  const headIndex = input.messages.indexOf(input.headAnchor);
  if (headIndex < 0) return { reason: 'head_missing' };

  const beforeTokens = estimateMessagesTokens(input.messages, 4);
  if (beforeTokens < Math.floor(input.contextWindow * input.threshold)) {
    return { reason: 'below_pressure' };
  }

  const projectionIndex = input.messages.findIndex(
    (message, index) => index > headIndex && message.contextKind === 'semantic_projection',
  );
  const shadowCoveredIndex = input.shadowCoveredThrough
    ? input.messages.indexOf(input.shadowCoveredThrough)
    : -1;
  const sourceStartIndex = Math.max(headIndex, projectionIndex, shadowCoveredIndex) + 1;
  const sourceEndIndex = input.messages.length;
  const sourceMessages = input.messages.slice(sourceStartIndex, sourceEndIndex);
  const newlyCompletedTokens = estimateMessagesTokens(sourceMessages, 4);
  if (newlyCompletedTokens < input.minNewTokens) {
    return { reason: 'insufficient_new_history' };
  }

  const previousProjectionId =
    projectionIndex >= 0 ? readProjectionId(input.messages[projectionIndex]) : undefined;

  return {
    candidate: {
      headIndex,
      sourceStartIndex,
      sourceEndIndex,
      beforeTokens,
      newlyCompletedTokens,
      previousProjectionId,
      sourceMessages,
    },
  };
}

export function buildSemanticCompactRequest(candidate: SemanticCompactCandidate): string {
  const fields = [
    'objective',
    'constraints',
    'completedWork',
    'currentState',
    'decisions',
    'failedApproaches',
    'unresolvedWork',
    'nextAction',
  ];
  return JSON.stringify(
    {
      type: 'suncode.semantic_compact_request',
      version: 1,
      coverage: {
        sourceStartIndex: candidate.sourceStartIndex,
        sourceEndIndex: candidate.sourceEndIndex,
        sourceDigest: digestMessages(candidate.sourceMessages),
        previousProjectionId: candidate.previousProjectionId,
      },
      requirements: {
        output: 'json_only_no_markdown',
        preserveExactUserHead: true,
        summarizePriorReplay: false,
        fields,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: fields,
          properties: {
            objective: { type: 'string' },
            constraints: { type: 'array', items: { type: 'string' } },
            completedWork: { type: 'array', items: { type: 'string' } },
            currentState: { type: 'array', items: { type: 'string' } },
            decisions: { type: 'array', items: { type: 'string' } },
            failedApproaches: { type: 'array', items: { type: 'string' } },
            unresolvedWork: { type: 'array', items: { type: 'string' } },
            nextAction: { type: 'string' },
          },
        },
      },
    },
    null,
    2,
  );
}

export function createSemanticProjection(input: {
  outputText: string;
  headAnchor: Message;
  candidate: SemanticCompactCandidate;
  maxProjectionTokens: number;
}): { projection?: SemanticProjection; message?: Message; reason?: string } {
  const state = parseProjectionState(input.outputText);
  if (!state) return { reason: 'invalid_projection_output' };

  const sourceDigest = digestMessages(input.candidate.sourceMessages);
  const headDigest = digestMessages([input.headAnchor]);
  const stateText = JSON.stringify(state);
  const estimatedTokens = Math.ceil(stateText.length / 4);
  if (estimatedTokens > input.maxProjectionTokens) {
    return { reason: 'projection_over_budget' };
  }

  const id = createHash('sha256')
    .update(input.candidate.previousProjectionId ?? '')
    .update(sourceDigest)
    .update(stateText)
    .digest('hex')
    .slice(0, 24);
  const projection: SemanticProjection = {
    id,
    previousProjectionId: input.candidate.previousProjectionId,
    headDigest,
    sourceDigest,
    estimatedTokens,
    state,
  };
  const message: Message = {
    role: 'user',
    contextKind: 'semantic_projection',
    content: JSON.stringify(
      {
        type: 'suncode.semantic_projection',
        version: 1,
        projectionId: projection.id,
        previousProjectionId: projection.previousProjectionId,
        headDigest: projection.headDigest,
        sourceDigest: projection.sourceDigest,
        state: projection.state,
      },
      null,
      2,
    ),
  };

  return { projection, message };
}

export function applySemanticProjection(input: {
  messages: Message[];
  headAnchor: Message;
  projectionMessage: Message;
  openTail?: Message[];
}): Message[] | undefined {
  const headIndex = input.messages.indexOf(input.headAnchor);
  if (headIndex < 0) return undefined;
  return [
    ...input.messages.slice(0, headIndex + 1),
    input.projectionMessage,
    ...(input.openTail ?? []),
  ];
}

export function digestMessages(messages: Message[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

function readProjectionId(message: Message): string | undefined {
  if (message.contextKind !== 'semantic_projection' || typeof message.content !== 'string') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(message.content) as { projectionId?: unknown };
    return typeof parsed.projectionId === 'string' ? parsed.projectionId : undefined;
  } catch {
    return undefined;
  }
}

function parseProjectionState(text: string): SemanticProjectionState | undefined {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return undefined;

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const constraints = normalizeStringArray(parsed.constraints);
    const completedWork = normalizeStringArray(parsed.completedWork);
    const currentState = normalizeStringArray(parsed.currentState);
    const decisions = normalizeStringArray(parsed.decisions);
    const failedApproaches = normalizeStringArray(parsed.failedApproaches);
    const unresolvedWork = normalizeStringArray(parsed.unresolvedWork);
    if (
      typeof parsed.objective !== 'string' ||
      typeof parsed.nextAction !== 'string' ||
      !constraints ||
      !completedWork ||
      !currentState ||
      !decisions ||
      !failedApproaches ||
      !unresolvedWork
    ) {
      return undefined;
    }
    return {
      objective: parsed.objective,
      constraints,
      completedWork,
      currentState,
      decisions,
      failedApproaches,
      unresolvedWork,
      nextAction: parsed.nextAction,
    };
  } catch {
    return undefined;
  }
}

function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced?.startsWith('{') && fenced.endsWith('}')) return fenced;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  return isStringArray(value) ? value : undefined;
}
