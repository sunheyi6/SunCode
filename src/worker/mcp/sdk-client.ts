import type { Tool } from '../tools/types';
import type { McpServerConfig } from '@shared/types';
import type { McpClient } from './client';

/**
 * MCP client implementation using @modelcontextprotocol/sdk.
 * This handles the actual JSON-RPC communication over stdio.
 */

// Dynamically typed to avoid hard dependency issues
interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export async function createSDKMcpClient(config: McpServerConfig): Promise<McpClient> {
  // Dynamic import to handle missing SDK gracefully
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env as Record<string, string> | undefined,
  });

  const client = new Client({ name: 'suncode', version: '0.1.0' }, { capabilities: { tools: {} } });

  let connected = false;

  const wrapper: McpClient = {
    async connect(): Promise<Tool[]> {
      try {
        await client.connect(transport);
        connected = true;

        // Discover tools from the MCP server
        const result = await client.listTools();
        const mcpTools = result.tools as McpToolDef[];

        const tools: Tool[] = mcpTools.map((mcpTool) => ({
          name: `mcp__${config.name}__${mcpTool.name}`,
          isReadonly: false,
          description: mcpTool.description || `MCP tool: ${mcpTool.name} from ${config.name}`,
          parameters: {
            type: 'object',
            properties: (mcpTool.inputSchema?.properties as Record<string, unknown>) || {},
            required: (mcpTool.inputSchema?.required as string[]) || [],
          },
          async execute(params: Record<string, unknown>) {
            try {
              const result = await client.callTool({
                name: mcpTool.name,
                arguments: params,
              });
              const content = (result.content as Array<{ type: string; text?: string }>)
                .map((c) => c.text || '')
                .join('\n');
              return {
                toolCallId: '',
                name: `mcp__${config.name}__${mcpTool.name}`,
                success: true,
                output: content,
              };
            } catch (error) {
              return {
                toolCallId: '',
                name: `mcp__${config.name}__${mcpTool.name}`,
                success: false,
                error: (error as Error).message,
                output: '',
              };
            }
          },
          getDefinition() {
            return {
              name: `mcp__${config.name}__${mcpTool.name}`,
              description: this.description,
              parameters: this.parameters,
            };
          },
        }));

        console.log(`MCP server "${config.name}": connected, ${tools.length} tools discovered`);
        return tools;
      } catch (error) {
        console.warn(
          `MCP server "${config.name}": connection failed - ${(error as Error).message}`,
        );
        connected = false;
        return [];
      }
    },

    async disconnect(): Promise<void> {
      if (connected) {
        try {
          await client.close();
        } catch {
          // Ignore close errors
        }
        connected = false;
      }
    },

    isConnected(): boolean {
      return connected;
    },

    getServerName(): string {
      return config.name;
    },
  };

  return wrapper;
}
