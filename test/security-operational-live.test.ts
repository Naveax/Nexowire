import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  sign,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CredentialStore } from '../src/security/credential-store.js';

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString(
    'base64url',
  );
}

function jwt(
  privateKey: KeyObject,
  payload: Record<string, unknown>,
  kid = 'operational-key',
): string {
  const header = b64({
    alg: 'RS256',
    kid,
    typ: 'JWT',
  });
  const body = b64(payload);
  const input = Buffer.from(header + '.' + body, 'ascii');
  return (
    header +
    '.' +
    body +
    '.' +
    sign('RSA-SHA256', input, privateKey).toString('base64url')
  );
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve) =>
    server.close(() => resolve()),
  );
  return port;
}

async function waitForHealth(
  url: string,
  child: ChildProcess,
  stderr: () => string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        'Nexowire hub exited before health check: ' +
          child.exitCode +
          '\n' +
          stderr(),
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return (await response.json()) as Record<string, unknown>;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    'Timed out waiting for live Nexowire HTTPS hub.\n' +
      stderr(),
  );
}

async function connectClient(
  url: string,
  token: string,
): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const client = new Client({
    name: 'nexowire-security-operational-test',
    version: '1.0.0',
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    {
      requestInit: {
        headers: {
          Authorization: 'Bearer ' + token,
        },
      },
    },
  );
  await client.connect(transport);
  return { client, transport };
}

test(
  'live HTTPS MCP combines OIDC scopes with hash-only credential revocation',
  {
    skip: process.env.NEXOWIRE_LIVE_SECURITY_TEST !== '1',
    timeout: 90_000,
  },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-security-live-'),
    );
    const stateDir = path.join(root, 'state');
    const certFile = path.join(root, 'tls-cert.pem');
    const keyFile = path.join(root, 'tls-key.pem');

    const openssl = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-subj',
        '/CN=127.0.0.1',
        '-days',
        '1',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.equal(
      openssl.status,
      0,
      'openssl certificate generation failed: ' +
        (openssl.stderr || openssl.stdout || ''),
    );

    const { publicKey, privateKey } = generateKeyPairSync(
      'rsa',
      { modulusLength: 2048 },
    );
    const jwk = publicKey.export({
      format: 'jwk',
    }) as JsonWebKey;
    jwk.kid = 'operational-key';
    jwk.use = 'sig';
    jwk.alg = 'RS256';

    let issuer = '';
    const oidcServer = createServer((req, res) => {
      if (
        req.url === '/.well-known/openid-configuration'
      ) {
        res.writeHead(200, {
          'content-type': 'application/json',
        });
        res.end(
          JSON.stringify({
            issuer,
            jwks_uri: issuer + '/keys',
          }),
        );
        return;
      }
      if (req.url === '/keys') {
        res.writeHead(200, {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      oidcServer.listen(0, '127.0.0.1', resolve),
    );
    const oidcAddress = oidcServer.address();
    assert.ok(
      oidcAddress && typeof oidcAddress === 'object',
    );
    issuer =
      'http://127.0.0.1:' + oidcAddress.port;

    const credentials = new CredentialStore(stateDir);
    await credentials.initialize();
    const stored = await credentials.issue('mcp', {
      name: 'operational-stored-user',
      role: 'user',
      allowedTools: ['skills_list'],
      ttlMs: 60_000,
    });

    const port = await reservePort();
    let stderrText = '';
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'http'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NEXOWIRE_HTTP_HOST: '127.0.0.1',
          NEXOWIRE_HTTP_PORT: String(port),
          NEXOWIRE_STATE_DIR: stateDir,
          NEXOWIRE_TLS_CERT_FILE: certFile,
          NEXOWIRE_TLS_KEY_FILE: keyFile,
          NEXOWIRE_OIDC_ISSUER: issuer,
          NEXOWIRE_OIDC_AUDIENCE:
            'nexowire-operational-test',
          NEXOWIRE_OIDC_ALLOW_INSECURE_HTTP: '1',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
      if (stderrText.length > 32_768) {
        stderrText = stderrText.slice(-32_768);
      }
    });

    const previousTlsSetting =
      process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    t.after(async () => {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED =
        previousTlsSetting;
      for (const candidate of [child]) {
        if (candidate.exitCode === null) {
          candidate.kill('SIGTERM');
          await new Promise((resolve) =>
            setTimeout(resolve, 150),
          );
          if (candidate.exitCode === null) {
            candidate.kill('SIGKILL');
          }
        }
      }
      await new Promise<void>((resolve) =>
        oidcServer.close(() => resolve()),
      );
      await fs.rm(root, {
        recursive: true,
        force: true,
      });
    });

    const base = 'https://127.0.0.1:' + port;
    const health = await waitForHealth(
      base + '/health',
      child,
      () => stderrText,
    );
    assert.equal(health.ok, true);
    assert.equal(health.transport, 'https');

    const storedClient = await connectClient(
      base + '/mcp',
      stored.token,
    );
    t.after(async () => {
      await storedClient.client.close().catch(() => undefined);
    });
    const storedTools = await storedClient.client.listTools();
    assert.deepEqual(
      storedTools.tools.map((tool) => tool.name),
      ['skills_list'],
    );

    await credentials.revoke(stored.credential.id);
    await assert.rejects(
      () => storedClient.client.listTools(),
      /401|unauthorized|Unauthorized/i,
    );

    const nowSeconds = Math.floor(Date.now() / 1000);
    const oidcToken = jwt(privateKey, {
      iss: issuer,
      sub: 'external-operator',
      aud: 'nexowire-operational-test',
      iat: nowSeconds - 5,
      exp: nowSeconds + 300,
      nexowire_role: 'operator',
      nexowire_tools: [
        'skills_list',
        'audit_query',
        'device_alias_set',
      ],
    });

    const oidcClient = await connectClient(
      base + '/mcp',
      oidcToken,
    );
    t.after(async () => {
      await oidcClient.client.close().catch(() => undefined);
    });
    const oidcTools = (
      await oidcClient.client.listTools()
    ).tools.map((tool) => tool.name);

    assert.ok(oidcTools.includes('skills_list'));
    assert.ok(oidcTools.includes('audit_query'));
    assert.equal(
      oidcTools.includes('device_alias_set'),
      false,
      'operator role must not discover admin-only mutation tools',
    );

    const wrong = new Client({
      name: 'nexowire-security-wrong-token',
      version: '1.0.0',
    });
    const wrongTransport =
      new StreamableHTTPClientTransport(
        new URL(base + '/mcp'),
        {
          requestInit: {
            headers: {
              Authorization: 'Bearer definitely-wrong',
            },
          },
        },
      );
    await assert.rejects(
      () => wrong.connect(wrongTransport),
      /401|unauthorized|Unauthorized/i,
    );
    await wrong.close().catch(() => undefined);

    const credentialFile = await fs.readFile(
      path.join(stateDir, 'credentials.json'),
      'utf8',
    );
    assert.equal(
      credentialFile.includes(stored.token),
      false,
    );
    assert.match(
      credentialFile,
      /"tokenHash":\s*"[a-f0-9]{64}"/,
    );
  },
);
