import type { Tool } from '../tools/types';
import type { McpServerConfig } from '@shared/types';
import { createMcpClient } from './client';
import type { McpClient } from './client';

/**
 * Manages MCP server connections and tool discovery.
 * Handles connecting, disconnecting, and reconnecting to configured MCP servers.
 */
export class McpManager {
  private clients: McpClient[] = [];
  private configs: McpServerConfig[];

  constructor(configs: McpServerConfig[]) {
    this.configs = configs;
  }

  /**
   * Connect to all enabled MCP servers and discover their tools.
   */
  async connectAll(): Promise<Tool[]> {
    const allTools: Tool[] = [];

    for (const config of this.configs) {
      if (!config.enabled) {
        console.log(`MCP server "${config.name}": disabled, skipping`);
        continue;
      }

      try {
        const client = await createMcpClient(config);
        const tools = await client.connect();
        allTools.push(...tools);
        this.clients.push(client);
      } catch (error) {
        console.warn(
          `MCP server "${config.name}": failed to initialize - ${(error as Error).message}`,
        );
      }
    }

    console.log(`MCP: ${this.clients.length} servers connected, ${allTools.length} total tools`);
    return allTools;
  }

  /**
   * Disconnect from all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    const promises = this.clients.map((client) => client.disconnect());
    await Promise.allSettled(promises);
    this.clients = [];
  }

  /**
   * Update server configurations and reconnect.
   */
  async updateConfigs(newConfigs: McpServerConfig[]): Promise<Tool[]> {
    await this.disconnectAll();
    this.configs = newConfigs;
    return this.connectAll();
  }

  /**
   * Get the names of connected MCP servers.
   */
  getConnectedServers(): string[] {
    return this.clients
      .filter((c) => c.isConnected())
      .map((c) => c.getServerName());
  }
}

/**
 * Create an MCP manager with the given server configurations.
 */
export function createMcpManager(configs: McpServerConfig[]): McpManager {
  return new McpManager(configs);
}
