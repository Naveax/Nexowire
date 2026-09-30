import { createServer, type IncomingMessage } from 'node:http';
import { spawnSync } from 'node:child_process';
import { matchesBearerHeader, parseTokenList } from '../security/tokens.js';
import {
  isPrivilegedBrokerCapability,
  privilegeRequirement,
} from '../security/privilege.js';
import { executeWindowsCapability } from './windows-control.js';
import { executeWindowsEnvironmentCapability } from './windows-environment.js';
import { normalizeAgentError } from './executors.js';
import { loadOrCreatePrivilegedBrokerToken } from '../security/privileged-broker-secret.js';

export interface PrivilegedBrokerServerOptions {
  host?: string;
  port?: number;
  tokens: readonly string[];
  maxBodyBytes?: number;
  requireElevation?: boolean;
  execute?: (
    capability: string,
    input: unknown,
  ) => Promise<unknown>;
}

export function isWindowsProcessElevated(): boolean {
  if (process.platform !== 'win32') return false;
  const command =
    '[Security.Principal.WindowsPrincipal]' +
    '[Security.Principal.WindowsIdentity]::GetCurrent()' +
    ' | ForEach-Object { $_.IsInRole(' +
    '[Security.Principal.WindowsBuiltInRole]::Administrator) }';
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  return (
    result.status === 0 &&
    result.stdout.trim().toLowerCase() === 'true'
  );
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const raw of request) {
    const chunk = Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      const error = new Error(
        'Privileged broker request body exceeds limit.',
      ) as Error & { code?: string };
      error.code = 'PRIVILEGED_BROKER_BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startPrivilegedBroker(
  options: PrivilegedBrokerServerOptions,
) {
  if (process.platform !== 'win32') {
    throw new Error(
      'The current privileged broker supports Windows only.',
    );
  }
  if (
    options.requireElevation !== false &&
    !isWindowsProcessElevated()
  ) {
    throw new Error(
      'Privileged broker must run from an elevated Windows process.',
    );
  }

  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    throw new Error(
      'Privileged broker refuses non-loopback binding.',
    );
  }

  const tokens = parseTokenList(options.tokens.join(','));
  if (tokens.length === 0) {
    throw new Error(
      'Privileged broker requires at least one bearer token.',
    );
  }

  const maxBodyBytes = Math.min(
    4 * 1024 * 1024,
    Math.max(64 * 1024, options.maxBodyBytes ?? 1024 * 1024),
  );

  const server = createServer(async (request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/execute'
    ) {
      response.writeHead(404, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND' } }));
      return;
    }

    if (
      !matchesBearerHeader(
        request.headers.authorization,
        tokens,
      )
    ) {
      response.writeHead(401, {
        'content-type': 'application/json',
      });
      response.end(
        JSON.stringify({
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid privileged broker bearer token.',
          },
        }),
      );
      return;
    }

    try {
      const decoded = (await readJsonBody(
        request,
        maxBodyBytes,
      )) as {
        capability?: unknown;
        input?: unknown;
      };
      const capability =
        typeof decoded.capability === 'string'
          ? decoded.capability
          : '';

      if (!isPrivilegedBrokerCapability(capability)) {
        response.writeHead(400, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify({
            ok: false,
            error: {
              code: 'PRIVILEGED_CAPABILITY_UNSUPPORTED',
              message:
                'Capability is not allowed through the privileged broker.',
            },
          }),
        );
        return;
      }

      if (
        privilegeRequirement(capability, decoded.input) !==
        'elevated'
      ) {
        response.writeHead(400, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify({
            ok: false,
            error: {
              code: 'PRIVILEGED_BROKER_NOT_REQUIRED',
              message:
                'Operation does not require elevated execution.',
            },
          }),
        );
        return;
      }

      const execute =
        options.execute ??
        (async (
          requestedCapability: string,
          requestedInput: unknown,
        ) =>
          requestedCapability.startsWith('windows.environment.')
            ? await executeWindowsEnvironmentCapability(
                requestedCapability,
                requestedInput,
              )
            : await executeWindowsCapability(
                requestedCapability,
                requestedInput,
              ));

      const data = await execute(
        capability,
        decoded.input,
      );

      response.writeHead(200, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ ok: true, data }));
    } catch (error) {
      const normalized = normalizeAgentError(error);
      response.writeHead(400, {
        'content-type': 'application/json',
      });
      response.end(
        JSON.stringify({
          ok: false,
          error: normalized,
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port ?? 43112, host);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error(
      'Privileged broker did not expose a TCP address.',
    );
  }

  return {
    server,
    url: `http://${host}:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
    },
  };
}

export async function runPrivilegedBroker(
  env: NodeJS.ProcessEnv = process.env,
): Promise<never> {
  let tokens = parseTokenList(
    env.NEXOWIRE_PRIVILEGED_BROKER_TOKEN,
    env.NEXOWIRE_PRIVILEGED_BROKER_TOKENS,
  );
  if (tokens.length === 0) {
    tokens = [
      await loadOrCreatePrivilegedBrokerToken({
        ...(env.NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE?.trim()
          ? {
              file: env.NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE.trim(),
            }
          : {}),
      }),
    ];
  }
  const port = Number.parseInt(
    env.NEXOWIRE_PRIVILEGED_BROKER_PORT ?? '43112',
    10,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      'Invalid NEXOWIRE_PRIVILEGED_BROKER_PORT.',
    );
  }

  const handle = await startPrivilegedBroker({
    host:
      env.NEXOWIRE_PRIVILEGED_BROKER_HOST?.trim() ||
      '127.0.0.1',
    port,
    tokens,
  });

  process.stdout.write(
    `Nexowire privileged broker listening on ${handle.url}\n`,
  );

  const stop = (): void => {
    void handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  return await new Promise<never>(() => undefined);
}
