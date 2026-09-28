import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createNexowireMcpServer, type McpContext } from './create-server.js';

export async function runStdioServer(context: McpContext): Promise<void> {
  const server = createNexowireMcpServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
