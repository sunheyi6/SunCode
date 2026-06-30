import type { MessageRole, ToolCallContent, ToolDefinition } from '@shared/types';

const STRUCTURED_CONTENT_VERSION = 1;

export interface StructuredSystemPromptInput {
  basePrompt: string;
  permissionMode: string;
  planModeNotice?: string;
  guidelines: string[];
  tools: Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'> & { snippet: string }>;
  memoryContent?: string;
  agentsMdContent?: string;
  planModeInstructions?: string;
  skillsContent?: string;
  currentDate: string;
  workingDirectory: string;
}

export interface StructuredTextMessageInput {
  role: Exclude<MessageRole, 'system' | 'tool'>;
  text: string;
  toolCalls?: ToolCallContent[];
}

export function stringifyStructuredContent(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

export function buildStructuredSystemPrompt(input: StructuredSystemPromptInput): string {
  return stringifyStructuredContent({
    type: 'suncode.system_prompt',
    version: STRUCTURED_CONTENT_VERSION,
    basePrompt: input.basePrompt,
    mode: {
      permissionMode: input.permissionMode,
      planModeNotice: input.planModeNotice,
    },
    guidelines: input.guidelines,
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      snippet: tool.snippet,
      parameters: tool.parameters,
    })),
    context: {
      memory: input.memoryContent,
      projectInstructions: input.agentsMdContent,
      planModeInstructions: input.planModeInstructions,
      skills: input.skillsContent,
    },
    environment: {
      currentDate: input.currentDate,
      workingDirectory: input.workingDirectory,
    },
  });
}

export function buildStructuredTextMessage(input: StructuredTextMessageInput): string {
  return stringifyStructuredContent({
    type: 'suncode.message',
    version: STRUCTURED_CONTENT_VERSION,
    role: input.role,
    content: {
      text: input.text,
    },
    toolCalls: input.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: safeParseToolArguments(toolCall.arguments),
    })),
  });
}

export function buildStructuredTaskPrompt(
  kind: string,
  payload: Record<string, unknown>,
): string {
  return stringifyStructuredContent({
    type: 'suncode.task_prompt',
    version: STRUCTURED_CONTENT_VERSION,
    kind,
    payload,
  });
}

function safeParseToolArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return argumentsJson;
  }
}
