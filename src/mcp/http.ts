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
import { createControlPlaneAgentCredentialVerifier } from '../hub/control-plane-agent-auth.js';
import { ControlPlaneMcpClient } from '../hub/control-plane-mcp-auth.js';
import {
  resolveMcpAuthorization,
  type BearerAuthorization,
} from '../security/auth.js';
import { OidcVerifier } from '../security/oidc.js';
import { deniedMcpToolNames } from '../security/tool-authorization.js';
import { createNexowireMcpServer, type McpContext } from './create-server.js';
import { enforceHostedMcpMetering } from './hosted-metering.js';
import { onlineCapabilityUnion } from './tool-capabilities.js';

export function configuredHttpAllowedHosts(
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const raw = env.NEXOWIRE_HTTP_ALLOWED_HOSTS?.trim();
  if (!raw) return undefined;

  const extra = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  for (const host of extra) {
    if (
      host === '*' ||
      host.includes('/') ||
      host.includes('\\') ||
      host.includes(' ') ||
      host.length > 253
    ) {
      throw new Error(
        'NEXOWIRE_HTTP_ALLOWED_HOSTS must contain explicit hostnames only.',
      );
    }
  }

  return [
    ...new Set([
      '127.0.0.1',
      'localhost',
      '[::1]',
      ...extra,
    ]),
  ];
}

export async function runHttpServer(
  config: NexowireConfig,
  broker: AgentBroker,
  context: McpContext,
): Promise<void> {
  const remoteAgentCredentialVerifier =
    config.controlPlaneAgentAuth
      ? createControlPlaneAgentCredentialVerifier({
          controlPlaneUrl:
            config.controlPlaneAgentAuth.url,
          serviceToken:
            config.controlPlaneAgentAuth.serviceToken,
          ...(config.controlPlaneAgentAuth.timeoutMs !== undefined
            ? {
                timeoutMs:
                  config.controlPlaneAgentAuth.timeoutMs,
              }
            : {}),
        })
      : undefined;

  const remoteMcpClient =
    config.controlPlaneAgentAuth &&
    config.mcpResourceUrl
      ? new ControlPlaneMcpClient({
          controlPlaneUrl:
            config.controlPlaneAgentAuth.url,
          serviceToken:
            config.controlPlaneAgentAuth.serviceToken,
          ...(config.controlPlaneAgentAuth.timeoutMs !== undefined
            ? {
                timeoutMs:
                  config.controlPlaneAgentAuth.timeoutMs,
              }
            : {}),
        })
      : undefined;

  const resourceMetadataUrl =
    config.mcpResourceUrl
      ? new URL(
          '/.well-known/oauth-protected-resource/mcp',
          config.mcpResourceUrl,
        ).toString()
      : undefined;

  assertSafeRemoteBinding(config, {
    mcp:
      (context.credentials?.hasUsable('mcp') ?? false) ||
      Boolean(config.oidc) ||
      Boolean(remoteMcpClient),
    agent:
      (context.credentials?.hasUsable('agent') ?? false) ||
      Boolean(remoteAgentCredentialVerifier),
  });
  const allowedHosts = configuredHttpAllowedHosts();
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
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

  if (
    remoteMcpClient &&
    config.mcpResourceUrl &&
    config.controlPlaneAgentAuth
  ) {
    const metadata = {
      resource: config.mcpResourceUrl,
      authorization_servers: [
        config.controlPlaneAgentAuth.url,
      ],
      scopes_supported: ['mcp', 'offline_access'],
    };
    for (const metadataPath of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      app.get(
        metadataPath,
        (_req: Request, res: Response) => {
          res.setHeader('cache-control', 'no-store');
          res.json(metadata);
        },
      );
    }
  }

  const mcpTokens = mcpAuthTokens(config);
  const oidcVerifier = config.oidc
    ? new OidcVerifier(config.oidc)
    : undefined;
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    const authRequired =
      mcpTokens.length > 0 ||
      context.credentials?.hasConfigured('mcp') === true ||
      Boolean(oidcVerifier) ||
      Boolean(remoteMcpClient);

    if (!authRequired) {
      next();
      return;
    }

    void resolveMcpAuthorization(
      req.headers.authorization,
      mcpTokens,
      context.credentials,
      oidcVerifier,
      remoteMcpClient
        ? (header) =>
            remoteMcpClient.authenticate(header)
        : undefined,
    )
      .then((authorization) => {
        if (!authorization) {
          if (resourceMetadataUrl) {
            res.setHeader(
              'WWW-Authenticate',
              'Bearer resource_metadata="' +
                resourceMetadataUrl +
                '"',
            );
          }
          res.status(401).json({ error: 'unauthorized' });
          return;
        }
        res.locals.nexowireAuthorization =
          authorization satisfies BearerAuthorization;
        next();
      })
      .catch(() => {
        if (resourceMetadataUrl) {
          res.setHeader(
            'WWW-Authenticate',
            'Bearer resource_metadata="' +
              resourceMetadataUrl +
              '"',
          );
        }
        res.status(401).json({ error: 'unauthorized' });
      });
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
    const metering =
      await enforceHostedMcpMetering({
        authorization,
        authorizationHeader:
          req.headers.authorization,
        body: req.body,
        client: remoteMcpClient,
      });
    if (!metering.allowed) {
      res.status(metering.status ?? 503).json({
        error:
          metering.error ??
          'service_unavailable',
        code:
          metering.code ??
          'MCP_METERING_UNAVAILABLE',
        ...(metering.remainingCredits !== undefined
          ? {
              remaining_credits:
                metering.remainingCredits,
            }
          : {}),
      });
      return;
    }

    const availableCapabilities = onlineCapabilityUnion(
      await context.providers.listTargets(),
    );

    const mcp = createNexowireMcpServer({
      ...context,
      ...(authorization
        ? { toolAuthorization: authorization }
        : {}),
      availableCapabilities,
    });
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
      ...(remoteAgentCredentialVerifier
        ? {
            remoteCredentialVerifier:
              remoteAgentCredentialVerifier,
          }
        : {}),
    },
  );

  const shutdown = async (): Promise<void> => {
    for (const client of wss.clients) client.close(1001, 'Server shutting down');
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
}
