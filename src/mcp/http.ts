import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { NextFunction, Request, Response } from 'express';
import type { AgentBroker } from '../core/agent-broker.js';
import type { NexowireConfig } from '../config.js';
import {
  agentAuthTokens,
  assertSafeRemoteBinding,
  hasDirectTls,
  mcpAuthTokens,
} from '../config.js';
import { attachAgentWebSocketServer } from '../hub/agent-websocket.js';
import { RelayHubClient } from '../hub/relay-client.js';
import { matchesBearerHeader } from '../security/tokens.js';
import { createNexowireMcpServer, type McpContext } from './create-server.js';

export async function runHttpServer(
  config: NexowireConfig,
  broker: AgentBroker,
  context: McpContext,
): Promise<void> {
  assertSafeRemoteBinding(config);
  const app = createMcpExpressApp({ host: config.host });
  const tlsEnabled = hasDirectTls(config);
  const scheme = tlsEnabled ? 'https' : 'http';

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: 'nexowire',
      transport: scheme,
      agents: broker.list().length,
      time: new Date().toISOString(),
    });
  });

  const mcpTokens = mcpAuthTokens(config);
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    if (
      mcpTokens.length > 0 &&
      !matchesBearerHeader(req.headers.authorization, mcpTokens)
    ) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const mcp = createNexowireMcpServer(context);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({ error: 'method_not_allowed' });
  });

  app.delete('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({ error: 'method_not_allowed' });
  });

  const httpServer = tlsEnabled
    ? createHttpsServer(
        {
          cert: await readFile(config.tlsCertFile!),
          key: await readFile(config.tlsKeyFile!),
          minVersion: 'TLSv1.2',
        },
        app,
      )
    : createHttpServer(app);

  httpServer.listen(config.port, config.host, () => {
    process.stderr.write(
      `Nexowire hub listening on ${scheme}://${config.host}:${config.port}/mcp\n`,
    );
  });

  const wss = attachAgentWebSocketServer(
    httpServer,
    broker,
    agentAuthTokens(config),
  );

  const relay =
    config.relayUrl && config.relayToken
      ? new RelayHubClient({
          url: config.relayUrl,
          token: config.relayToken,
          broker,
        })
      : undefined;
  relay?.start();

  const shutdown = async (): Promise<void> => {
    await relay?.stop();
    for (const client of wss.clients) client.close(1001, 'Server shutting down');
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
}
