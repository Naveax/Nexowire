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
import {
  resolveBearerAuthorization,
  type BearerAuthorization,
} from '../security/auth.js';
import { deniedMcpToolNames } from '../security/tool-authorization.js';
import { createNexowireMcpServer, type McpContext } from './create-server.js';

export async function runHttpServer(
  config: NexowireConfig,
  broker: AgentBroker,
  context: McpContext,
): Promise<void> {
  assertSafeRemoteBinding(config, {
    mcp: context.credentials?.hasUsable('mcp') ?? false,
    agent: context.credentials?.hasUsable('agent') ?? false,
  });
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
    const authRequired =
      mcpTokens.length > 0 ||
      context.credentials?.hasConfigured('mcp') === true;

    if (!authRequired) {
      next();
      return;
    }

    const authorization = resolveBearerAuthorization(
      req.headers.authorization,
      'mcp',
      mcpTokens,
      context.credentials,
    );
    if (!authorization) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    res.locals.nexowireAuthorization =
      authorization satisfies BearerAuthorization;
    next();
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const authorization = res.locals
      .nexowireAuthorization as BearerAuthorization | undefined;
    const deniedTools = deniedMcpToolNames(
      req.body,
      authorization,
    );
    if (deniedTools.length > 0) {
      res.status(403).json({
        error: 'forbidden',
        code: 'MCP_TOOL_NOT_AUTHORIZED',
        denied_tools: [...new Set(deniedTools)],
      });
      return;
    }
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
    {
      credentialStore: context.credentials,
    },
  );

  const shutdown = async (): Promise<void> => {
    for (const client of wss.clients) client.close(1001, 'Server shutting down');
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
}
