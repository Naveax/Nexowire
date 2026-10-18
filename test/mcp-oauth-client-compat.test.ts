import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { McpOAuthService, McpOAuthError } from '../src/product/mcp-oauth.js';
import { MemoryMcpOAuthStore } from '../src/product/memory-mcp-oauth-store.js';
import { createMcpOAuthHttpHandler } from '../src/product/mcp-oauth-http.js';
import { ControlPlaneMcpClient } from '../src/hub/control-plane-mcp-auth.js';
import { resolveMcpAuthorization } from '../src/security/auth.js';

const issuer = 'https://auth.example.test';
const resource = 'https://mcp.example.test/mcp';
const verifier = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const pkce = createHash('sha256').update(verifier, 'ascii').digest('base64url');

function fixture() {
  let clock = Date.parse('2026-10-18T00:00:00.000Z');
  const oauth = new McpOAuthService(new MemoryMcpOAuthStore(), {
    issuer, resource, now: () => new Date(clock),
  });
  return { oauth, advance: (milliseconds: number) => { clock += milliseconds; } };
}

async function clientFlow(input: {
  oauth: McpOAuthService;
  account: string;
  registered: string;
  requested: string;
  scope?: string;
}) {
  const client = await input.oauth.registerClient({
    redirect_uris: [input.registered], token_endpoint_auth_method: 'none',
  }) as { client_id: string };
  const redirect = new URL(await input.oauth.authorize(input.account, new URLSearchParams({
    response_type: 'code', client_id: client.client_id,
    redirect_uri: input.requested, code_challenge: pkce,
    code_challenge_method: 'S256', resource,
    scope: input.scope ?? 'mcp offline_access',
    state: 'opaque-client-state',
  })));
  assert.equal(redirect.searchParams.get('state'), 'opaque-client-state');
  const code = redirect.searchParams.get('code')!;
  const params = new URLSearchParams({
    grant_type: 'authorization_code', code,
    client_id: client.client_id, redirect_uri: input.requested,
    code_verifier: verifier, resource,
  });
  return { clientId: client.client_id, code, params, redirect,
    issued: await input.oauth.token(params),
  };
}

test('ChatGPT is an independent DCR OAuth client with canonical audience and issuer', async () => {
  const { oauth } = fixture();
  const chatgpt = await clientFlow({
    oauth, account: 'chatgpt-owner',
    registered: 'https://chatgpt.com/connector_platform_oauth_redirect',
    requested: 'https://chatgpt.com/connector_platform_oauth_redirect',
  });
  assert.equal(chatgpt.redirect.origin, 'https://chatgpt.com');
  assert.equal((await oauth.authenticateAccessToken(chatgpt.issued.access_token))?.resource, resource);
  assert.deepEqual((await oauth.authenticateAccessToken(chatgpt.issued.access_token))?.scopes,
    ['mcp', 'offline_access']);
  await assert.rejects(oauth.token(chatgpt.params),
    (e: unknown) => e instanceof McpOAuthError && e.code === 'invalid_grant');
  const handler = createMcpOAuthHttpHandler(oauth, {
    authenticateSession: async () => null,
    loginRedirect: () => '/auth/github/start',
  });
  const discovery = await handler(new Request(issuer + '/.well-known/oauth-authorization-server'));
  assert.equal(discovery?.status, 200);
  const auth = await discovery!.json() as Record<string, unknown>;
  assert.equal(auth.issuer, issuer);
  assert.deepEqual(auth.protected_resources, [resource]);
  assert.deepEqual(auth.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(auth.token_endpoint_auth_methods_supported, ['none']);
  const protectedResource = await handler(new Request(
    issuer + '/.well-known/oauth-protected-resource/mcp',
  ));
  assert.equal(protectedResource?.status, 200);
  assert.deepEqual(await protectedResource!.json(), {
    resource, authorization_servers: [issuer],
    scopes_supported: ['mcp', 'offline_access'],
  });
});

test('Codex CLI DCR localhost/127.0.0.1 alias is limited to exact local callback', async () => {
  const { oauth } = fixture();
  const registered = 'http://127.0.0.1:39053/callback/cli-unique';
  const requested = 'http://localhost:39053/callback/cli-unique';
  const codex = await clientFlow({
    oauth, account: 'codex-owner', registered, requested,
  });
  assert.equal(codex.redirect.origin, 'http://localhost:39053');
  assert.ok(await oauth.authenticateAccessToken(codex.issued.access_token));
  const refresh = await oauth.token(new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: codex.issued.refresh_token!,
    client_id: codex.clientId, resource,
  }));
  assert.ok(refresh.refresh_token);
  assert.notEqual(refresh.refresh_token, codex.issued.refresh_token);
  await assert.rejects(oauth.token(new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: codex.issued.refresh_token!,
    client_id: codex.clientId, resource,
  })), (e: unknown) => e instanceof McpOAuthError && e.code === 'invalid_grant');

  for (const invalid of [
    'http://localhost:39054/callback/cli-unique',
    'http://localhost:39053/callback/other',
    'http://localhost:39053/callback/cli-unique?extra=1',
    'https://localhost:39053/callback/cli-unique',
    'http://evil.example:39053/callback/cli-unique',
  ]) {
    await assert.rejects(oauth.authorize('codex-owner', new URLSearchParams({
      response_type: 'code', client_id: codex.clientId,
      redirect_uri: invalid, code_challenge: pkce,
      code_challenge_method: 'S256', resource, scope: 'mcp',
    })), (e: unknown) => e instanceof McpOAuthError && e.code === 'invalid_request');
  }
});

test('OAuth token code is bound to client, redirect, PKCE and resource', async () => {
  const { oauth } = fixture();
  const codex = await clientFlow({
    oauth, account: 'owner-2', registered: 'http://127.0.0.1:32111/callback/fixed',
    requested: 'http://localhost:32111/callback/fixed',
  });
  // Once issued, token identity is immutable and a different resource cannot validate it.
  const other = new McpOAuthService(new MemoryMcpOAuthStore(), {
    issuer, resource: 'https://foreign.example.test/mcp',
  });
  assert.equal(await other.authenticateAccessToken(codex.issued.access_token), null);
  await assert.rejects(oauth.token(new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: codex.issued.refresh_token!,
    client_id: 'other-client', resource,
  })), (e: unknown) => e instanceof McpOAuthError && e.code === 'invalid_grant');
  await assert.rejects(oauth.token(new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: codex.issued.refresh_token!,
    client_id: codex.clientId, resource: 'https://foreign.example.test/mcp',
  })), (e: unknown) => e instanceof McpOAuthError && e.code === 'invalid_request');
});

test('expiry, explicit access-token revocation and refresh lifetime fail closed', async () => {
  const { oauth, advance } = fixture();
  const client = await clientFlow({
    oauth, account: 'owner-3',
    registered: 'https://chatgpt.com/oauth/callback/test',
    requested: 'https://chatgpt.com/oauth/callback/test',
  });
  advance(3_601_000);
  assert.equal(await oauth.authenticateAccessToken(client.issued.access_token), null);
  const refreshed = await oauth.token(new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: client.issued.refresh_token!,
    client_id: client.clientId, resource,
  }));
  assert.ok(await oauth.authenticateAccessToken(refreshed.access_token));
  assert.equal(await oauth.invalidateAccessToken(refreshed.access_token, 'other-owner'), false);
  assert.equal(await oauth.invalidateAccessToken(refreshed.access_token, 'owner-3'), true);
  assert.equal(await oauth.authenticateAccessToken(refreshed.access_token), null);
  advance(31 * 24 * 3600_000);
  await assert.rejects(oauth.token(new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshed.refresh_token!,
    client_id: client.clientId, resource,
  })), (e: unknown) => e instanceof McpOAuthError && e.code === 'invalid_grant');
});

test('wrong OAuth scope or invalid identity does not produce MCP dispatch authorization', async () => {
  for (const scopes of [['offline_access'], ['other'], [], 'mcp', ['mcp', 1]]) {
    const client = new ControlPlaneMcpClient({
      controlPlaneUrl: issuer, serviceToken: 'non-production-service-token',
      fetchImpl: async () => Response.json({
        authenticated: true, accountId: 'acct', role: 'user',
        scopes, allowedDeviceIds: ['device-1'],
      }),
    });
    const auth = await resolveMcpAuthorization(
      'Bearer nwx_mcp_not-a-real-credential', [], undefined, undefined,
      header => client.authenticate(header),
    );
    assert.equal(auth, undefined);
  }
  const unavailable = new ControlPlaneMcpClient({
    controlPlaneUrl: issuer, serviceToken: 'non-production-service-token',
    fetchImpl: async () => Response.json({authenticated: false}, {status: 401}),
  });
  await assert.rejects(
    () => unavailable.authenticate('Bearer nwx_mcp_not-a-real-credential'),
    (error: unknown) => error instanceof Error &&
      error.name === 'ControlPlaneMcpVerifierUnavailableError',
  );
});

test('OAuth HTTP errors classify malicious callbacks as safe invalid_request, not 500', async () => {
  const { oauth } = fixture();
  const handler = createMcpOAuthHttpHandler(oauth, {
    authenticateSession: async () => ({accountId: 'account', role: 'user'} as never),
    loginRedirect: () => '/auth/github/start',
  });
  const client = await oauth.registerClient({
    redirect_uris: ['https://chatgpt.com/oauth/callback/test'],
  }) as { client_id: string };
  const params = new URLSearchParams({
    response_type: 'code', client_id: client.client_id,
    redirect_uri: 'http://evil.example:8080/oauth/callback',
    code_challenge: pkce, code_challenge_method: 'S256', resource,
  });
  const response = await handler(new Request(issuer + '/oauth/authorize?' + params));
  assert.equal(response?.status, 400);
  const error = await response!.json() as Record<string, unknown>;
  assert.equal(error.error, 'invalid_request');
  assert.doesNotMatch(JSON.stringify(error), /evil\.example|nwx_mcp_|refresh_token/i);
});

test('OIDC invalid bearer differs from issuer outage, without disclosing secrets', async () => {
  const { classifyMcpAuthFailure } = await import('../src/mcp/http.js');
  const { OidcVerificationError } = await import('../src/security/oidc.js');
  for (const name of [
    'OIDC_TOKEN_MALFORMED',
    'OIDC_TOKEN_EXPIRED',
    'OIDC_SIGNATURE_INVALID',
    'OIDC_ISSUER_MISMATCH',
    'OIDC_AUDIENCE_MISMATCH',
    'OIDC_KEY_NOT_FOUND',
    'OIDC_ROLE_INVALID',
  ]) {
    assert.equal(classifyMcpAuthFailure(new OidcVerificationError(name, 'fixture')), 'token');
  }
  for (const name of [
    'OIDC_JWKS_INVALID', 'OIDC_HTTP_TIMEOUT', 'OIDC_HTTP_FAILED',
    'OIDC_DISCOVERY_ISSUER_MISMATCH', 'OIDC_CONFIG_INVALID',
  ]) {
    assert.equal(classifyMcpAuthFailure(new OidcVerificationError(name, 'fixture')), 'verification');
  }
  assert.equal(classifyMcpAuthFailure(new Error('opaque private error')), 'verification');
});

test('OIDC and hosted OAuth configured simultaneously route opaque token to correct verifier', async () => {
  const { OidcVerifier, OidcVerificationError } = await import('../src/security/oidc.js');
  let jwksFetches = 0;
  let hostedCalls = 0;
  const oidc = new OidcVerifier({
    issuer: 'https://issuer.example.test', audience: 'separate-jwt-resource',
    fetchFn: async () => { jwksFetches++; throw new Error('network unavailable'); },
  });
  const hostedToken = 'Bearer nwx_mcp_valid-looking-opaque-access-token';
  const granted = await resolveMcpAuthorization(
    hostedToken, [], undefined, oidc, async (header) => {
      hostedCalls++;
      assert.equal(header, hostedToken);
      return {
        accountId: 'authorized-account', role: 'user',
        allowedDeviceIds: ['device-assigned'],
      };
    },
  );
  assert.equal(granted?.kind, 'control-plane');
  assert.equal(hostedCalls, 1);
  assert.equal(jwksFetches, 0);
  await assert.rejects(
    resolveMcpAuthorization('Bearer not-a-jwt', [], undefined, oidc, async () => {
      throw new Error('should not contact hosted verifier for malformed JWT');
    }),
    (error: unknown) => error instanceof OidcVerificationError &&
      error.code === 'OIDC_TOKEN_MALFORMED',
  );
  const denied = await resolveMcpAuthorization(
    'Bearer nwx_mcp_bad-opaque-token', [], undefined, oidc, async () => {
      hostedCalls++;
      return undefined;
    },
  );
  assert.equal(denied, undefined);
  assert.equal(hostedCalls, 2);
  assert.equal(jwksFetches, 0);
});

test('control-plane missing scope is denied, not merely wrong explicit scope', async () => {
  for (const reply of [
    {authenticated:true,accountId:'a',role:'user',allowedDeviceIds:['device-a']},
    {authenticated:true,accountId:'a',role:'user',scopes:[],allowedDeviceIds:['device-a']},
  ]) {
    const client = new ControlPlaneMcpClient({
      controlPlaneUrl: issuer, serviceToken: 'non-production-service-token',
      fetchImpl: async () => Response.json(reply),
    });
    assert.equal(await client.authenticate('Bearer nwx_mcp_not-real'), undefined);
  }
});

test('hosted verifier transport failures are 503-class, not invalid user credentials', async () => {
  const { ControlPlaneMcpVerifierUnavailableError } =
    await import('../src/hub/control-plane-mcp-auth.js');
  const header = 'Bearer nwx_mcp_access-token-for-failure-test';
  const failures: Array<() => Promise<Response>> = [
    async () => new Response('sensitive-upstream-diagnostic', {status: 503}),
    async () => new Response('invalid-json-credential-secret', {status: 200}),
    async () => { throw new Error('sensitive-network-token-secret'); },
  ];
  for (const fetchImpl of failures) {
    const client = new ControlPlaneMcpClient({
      controlPlaneUrl: issuer,
      serviceToken: 'non-production-service-token',
      fetchImpl: async () => fetchImpl(),
    });
    await assert.rejects(
      client.authenticate(header),
      (error: unknown) => error instanceof ControlPlaneMcpVerifierUnavailableError &&
        error.code === 'MCP_AUTH_VERIFIER_UNAVAILABLE' &&
        !/sensitive|secret|token-for-failure-test/i.test(String(error)),
    );
  }
  const explicitDenial = new ControlPlaneMcpClient({
    controlPlaneUrl: issuer,
    serviceToken: 'non-production-service-token',
    fetchImpl: async () => Response.json({authenticated: false}),
  });
  assert.equal(await explicitDenial.authenticate(header), undefined);
  // Metering is outside this patch's scope: its historical fail-closed
  // undefined contract remains unchanged for an unavailable backend.
  const metering = new ControlPlaneMcpClient({
    controlPlaneUrl: issuer,
    serviceToken: 'non-production-service-token',
    fetchImpl: async () => { throw new Error('sensitive network outage'); },
  });
  assert.equal(await metering.chargeTool({
    accountId: 'fixture-account', eventId: 'fixture-event',
    toolName: 'machine_health',
  }), undefined);
});
