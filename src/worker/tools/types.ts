import type { ToolDefinition, ToolResult } from '@shared/types';

/**
 * Tool interface that all built-in and MCP tools implement.
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolDefinition['parameters'];
  execute(params: Record<string, unknown>): Promise<ToolResult>;
  getDefinition(): ToolDefinition;
}

/**
 * Base class for tools providing common functionality.
 */
export abstract class BaseTool implements Tool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: ToolDefinition['parameters'];

  abstract execute(params: Record<string, unknown>): Promise<ToolResult>;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
  }

  protected success(output: string): ToolResult {
    return {
      toolCallId: '',
      name: this.name,
      success: true,
      output,
    };
  }

  protected failure(error: string): ToolResult {
    return {
      toolCallId: '',
      name: this.name,
      success: false,
      error,
      output: '',
    };
  }
}

/**
 * Create a simple JSON schema parameter definition.
 */
export function p(
  type: string,
  description: string,
  extra: Record<string, unknown> = {},
): ToolDefinition['parameters'] {
  return { type, description, ...extra };
}

/**
 * Create an object-type parameter schema.
 */
export function obj(
  properties: Record<string, ToolDefinition['parameters']>,
  required: string[] = [],
  description = '',
): ToolDefinition['parameters'] {
  return {
    type: 'object',
    description,
    properties,
    required,
  };
}

/**
 * Create an array-type parameter schema.
 */
export function arr(
  items: ToolDefinition['parameters'],
  description = '',
): ToolDefinition['parameters'] {
  return {
    type: 'array',
    description,
    items,
  };
}
