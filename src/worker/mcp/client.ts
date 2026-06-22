import type { Tool } from '../tools/types';
import type { McpServerConfig } from '@shared/types';

/**
 * Simple MCP client that connects to an MCP server via stdio.
 * Uses the @modelcontextprotocol/sdk for full protocol support.
 * Falls back to a lightweight implementation if the SDK is not available.
 */
export interface McpClient {
  connect(): Promise<Tool[]>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getServerName(): string;
}

/**
 * Create an MCP client for a given server configuration.
 * Uses the official MCP SDK when available.
 */
export async function createMcpClient(config: McpServerConfig): Promise<McpClient> {
  try {
    // Try to use the official SDK
    const { createSDKMcpClient } = await import('./sdk-client');
    return await createSDKMcpClient(config);
  } catch {
    // Fallback: return a placeholder that indicates SDK not available
    return createFallbackClient(config);
  }
}

function createFallbackClient(config: McpServerConfig): McpClient {
  let connected = false;

  return {
    async connect(): Promise<Tool[]> {
      connected = true;
      console.warn(
        `MCP SDK not available. Server "${config.name}" will not provide tools. Install @modelcontextprotocol/sdk for MCP support.`,
      );
      return [];
    },

    async disconnect(): Promise<void> {
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    getServerName(): string {
      return config.name;
    },
  };
}
