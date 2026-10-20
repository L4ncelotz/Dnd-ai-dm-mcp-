import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Starts the MCP server on stdio transport.
 * Note: All diagnostics/logs must be directed to stderr, as stdout is reserved for JSON-RPC frames.
 */
export async function startStdioServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[dnd-mcp] MCP server running on stdio transport.\n');
}
