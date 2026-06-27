import { BaseTool, type Tool } from './types';
import { createReadTool } from './read';
import { createWriteTool } from './write';
import { createEditTool } from './edit';
import { createBashTool, type BashToolCallbacks } from './bash';
import { createGrepTool } from './grep';
import { createGlobTool } from './glob';
import { createLsTool } from './ls';
import { createFindTool } from './find';
import { createWebFetchTool } from './web-fetch';
import { createWebSearchTool } from './web-search';
import type { AppSettings } from '@shared/types';

/**
 * Tool Registry manages all available tools (built-in + MCP).
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`Tool "${tool.name}" is being overwritten`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getDefinitions(): ReturnType<Tool['getDefinition']>[] {
    return this.getAll().map((t) => t.getDefinition());
  }

  async execute(
    name: string,
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<import('@shared/types').ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        toolCallId,
        name,
        success: false,
        error: `Unknown tool: ${name}`,
        output: '',
      };
    }

    try {
      const result = await tool.execute(params);
      result.toolCallId = toolCallId;
      return result;
    } catch (error) {
      return {
        toolCallId,
        name,
        success: false,
        error: (error as Error).message,
        output: '',
      };
    }
  }
}

/**
 * Create a ToolRegistry pre-populated with built-in tools.
 * The subagent tool is NOT registered here — it's added by Agent after
 * creating the dispatcher, to avoid circular imports.
 */
export function createToolRegistry(
  workingDir: string,
  callbacks?: BashToolCallbacks,
  settings?: AppSettings,
): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(createReadTool(workingDir));
  registry.register(createWriteTool(workingDir));
  registry.register(createEditTool(workingDir));
  registry.register(createBashTool(workingDir, callbacks));
  registry.register(createGrepTool(workingDir));
  registry.register(createGlobTool(workingDir));
  registry.register(createLsTool(workingDir));
  registry.register(createFindTool(workingDir));
  registry.register(createWebFetchTool(workingDir));
  registry.register(createWebSearchTool(settings));

  return registry;
}
