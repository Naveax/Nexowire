import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemoryMcpOAuthStore } from '../src/product/memory-mcp-oauth-store.js';
import {
  McpOAuthError,
  McpOAuthService,
} from '../src/product/mcp-oauth.js';
import { createMcpOAuthHttpHandler } from '../src/product/mcp-oauth-http.js';

const issuer = 'https://auth.example.test';
const resource = 'https://mcp.example.test/mcp';
const now = new Date('2026-10-03T00:00:00.000Z');

function challenge(verifier: string): string {
  return createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');
}

async function setup() {
  const store = new MemoryMcpOAuthStore();
  const service = new McpOAuthService(store, {
    issuer,
    resource,
    now: () => now,
  });
  const registration = await service.registerClient({
    redirect_uris: [
      'https://chatgpt.com/oauth/callback/test',
    ],
    token_endpoint_auth_method: 'none',
  }) as {
    client_id: string;
    redirect_uris: string[];
  };
  return { store, service, registration };
}

test('MCP OAuth metadata advertises PKCE, DCR, refresh and protected resource', async () => {
  const { service } = await setup();
  assert.deepEqual(
    service.protectedResourceMetadata(),
    {
      resource,
      authorization_servers: [issuer],
      scopes_supported: ['mcp', 'offline_access'],
    },
  );

  const metadata = service.authorizationServerMetadata();
  assert.equal(metadata.issuer, issuer);
  assert.equal(
    metadata.authorization_endpoint,
    issuer + '/oauth/authorize',
  );
  assert.equal(
    metadata.registration_endpoint,
    issuer + '/oauth/register',
  );
  assert.deepEqual(
    metadata.code_challenge_methods_supported,
    ['S256'],
  );
  assert.deepEqual(
    metadata.token_endpoint_auth_methods_supported,
    ['none'],
  );
});

test('authorization code + PKCE issues scoped access and refresh tokens', async () => {
  const { service, registration } = await setup();
  const verifier =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: registration.client_id,
    redirect_uri:
      'https://chatgpt.com/oauth/callback/test',
    code_challenge: challenge(verifier),
    code_challenge_method: 'S256',
    resource,
    scope: 'mcp offline_access',
    state: 'state-123',
  });

  const redirect = new URL(
    await service.authorize('acct-1', params),
  );
  assert.equal(
    redirect.origin + redirect.pathname,
    'https://chatgpt.com/oauth/callback/test',
  );
  assert.equal(
    redirect.searchParams.get('state'),
    'state-123',
  );
  const code = redirect.searchParams.get('code');
  assert.match(code ?? '', /^nwx_code_/);

  const token = await service.token(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      client_id: registration.client_id,
      redirect_uri:
        'https://chatgpt.com/oauth/callback/test',
      code_verifier: verifier,
      resource,
    }),
  );

  assert.match(token.access_token, /^nwx_mcp_/);
  assert.match(token.refresh_token ?? '', /^nwx_refresh_/);
  assert.equal(token.token_type, 'Bearer');
  assert.equal(token.expires_in, 3600);
  assert.equal(token.scope, 'mcp offline_access');

  assert.deepEqual(
    await service.authenticateAccessToken(
      token.access_token,
    ),
    {
      accountId: 'acct-1',
      clientId: registration.client_id,
      resource,
      scopes: ['mcp', 'offline_access'],
    },
  );

  await assert.rejects(
    service.token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        client_id: registration.client_id,
        redirect_uri:
          'https://chatgpt.com/oauth/callback/test',
        code_verifier: verifier,
        resource,
      }),
    ),
    (error: unknown) =>
      error instanceof McpOAuthError &&
      error.code === 'invalid_grant',
  );
});

test('refresh tokens rotate and cannot be replayed', async () => {
  const { service, registration } = await setup();
  const verifier =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
  const redirect = new URL(
    await service.authorize(
      'acct-2',
      new URLSearchParams({
        response_type: 'code',
        client_id: registration.client_id,
        redirect_uri:
          'https://chatgpt.com/oauth/callback/test',
        code_challenge: challenge(verifier),
        code_challenge_method: 'S256',
        resource,
        scope: 'mcp offline_access',
      }),
    ),
  );

  const original = await service.token(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: redirect.searchParams.get('code')!,
      client_id: registration.client_id,
      redirect_uri:
        'https://chatgpt.com/oauth/callback/test',
      code_verifier: verifier,
      resource,
    }),
  );
  const refresh = original.refresh_token!;

  const rotated = await service.token(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: registration.client_id,
      resource,
    }),
  );

  assert.match(rotated.access_token, /^nwx_mcp_/);
  assert.match(rotated.refresh_token ?? '', /^nwx_refresh_/);
  assert.notEqual(rotated.refresh_token, refresh);

  await assert.rejects(
    service.token(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: registration.client_id,
        resource,
      }),
    ),
    (error: unknown) =>
      error instanceof McpOAuthError &&
      error.code === 'invalid_grant',
  );
});

test('OAuth client redirect and PKCE bindings fail closed', async () => {
  const { service, registration } = await setup();
  const verifier =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';

  await assert.rejects(
    service.authorize(
      'acct-1',
      new URLSearchParams({
        response_type: 'code',
        client_id: registration.client_id,
        redirect_uri: 'https://evil.example/callback',
        code_challenge: challenge(verifier),
        code_challenge_method: 'S256',
        resource,
        scope: 'mcp',
      }),
    ),
    /not registered/,
  );

  const redirect = new URL(
    await service.authorize(
      'acct-1',
      new URLSearchParams({
        response_type: 'code',
        client_id: registration.client_id,
        redirect_uri:
          'https://chatgpt.com/oauth/callback/test',
        code_challenge: challenge(verifier),
        code_challenge_method: 'S256',
        resource,
        scope: 'mcp',
      }),
    ),
  );

  await assert.rejects(
    service.token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: redirect.searchParams.get('code')!,
        client_id: registration.client_id,
        redirect_uri:
          'https://chatgpt.com/oauth/callback/test',
        code_verifier:
          'wrongwrongwrongwrongwrongwrongwrongwrongwrongwrong',
        resource,
      }),
    ),
    (error: unknown) =>
      error instanceof McpOAuthError &&
      error.code === 'invalid_grant',
  );
});

test('OAuth HTTP handler redirects unauthenticated authorization to login and serves metadata', async () => {
  const { service } = await setup();
  const unauthenticated =
    createMcpOAuthHttpHandler(service, {
      authenticateSession: async () => null,
      loginRedirect: () =>
        '/auth/github/start?next=%2Foauth%2Fauthorize',
    });

  const metadata = await unauthenticated(
    new Request(
      issuer +
        '/.well-known/oauth-authorization-server',
    ),
  );
  assert.ok(metadata);
  assert.equal(metadata.status, 200);

  const authorize = await unauthenticated(
    new Request(issuer + '/oauth/authorize'),
  );
  assert.ok(authorize);
  assert.equal(authorize.status, 302);
  assert.equal(
    authorize.headers.get('location'),
    '/auth/github/start?next=%2Foauth%2Fauthorize',
  );
});
