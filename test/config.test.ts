import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeRemoteBinding, isLoopbackHost, loadConfig } from '../src/config.js';

test('loopback host detection accepts local forms', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});

test('remote bind requires credentials and encrypted transport by default', () => {
  const base = loadConfig(
    {
      NEXOWIRE_HTTP_HOST: '0.0.0.0',
      NEXOWIRE_HTTP_PORT: '43110',
    },
    process.cwd(),
  );
  assert.throws(() => assertSafeRemoteBinding(base));

  const authenticated = {
    ...base,
    mcpBearerToken: 'mcp-secret',
    agentToken: 'agent-secret',
  };
  assert.throws(() => assertSafeRemoteBinding(authenticated));

  assert.doesNotThrow(() =>
    assertSafeRemoteBinding({
      ...authenticated,
      tlsCertFile: 'cert.pem',
      tlsKeyFile: 'key.pem',
    }),
  );

  assert.doesNotThrow(() =>
    assertSafeRemoteBinding({
      ...authenticated,
      allowInsecureRemote: true,
    }),
  );
});

test('token lists merge legacy/current credentials for rotation', () => {
  const config = loadConfig(
    {
      NEXOWIRE_HTTP_HOST: '0.0.0.0',
      NEXOWIRE_HTTP_PORT: '43110',
      NEXOWIRE_MCP_BEARER_TOKEN: 'current-mcp',
      NEXOWIRE_MCP_BEARER_TOKENS: 'old-mcp,current-mcp,next-mcp',
      NEXOWIRE_AGENT_TOKEN: 'current-agent',
      NEXOWIRE_AGENT_TOKENS: 'old-agent,current-agent,next-agent',
    },
    process.cwd(),
  );

  assert.deepEqual(config.mcpBearerTokens, [
    'current-mcp',
    'old-mcp',
    'next-mcp',
  ]);
  assert.deepEqual(config.agentTokens, [
    'current-agent',
    'old-agent',
    'next-agent',
  ]);
  assert.throws(() => assertSafeRemoteBinding(config));
  assert.doesNotThrow(() =>
    assertSafeRemoteBinding({
      ...config,
      tlsCertFile: 'cert.pem',
      tlsKeyFile: 'key.pem',
    }),
  );
});

test('remote bind accepts token sets even without legacy singular fields', () => {
  const config = loadConfig(
    {
      NEXOWIRE_HTTP_HOST: '0.0.0.0',
      NEXOWIRE_HTTP_PORT: '43110',
      NEXOWIRE_MCP_BEARER_TOKENS: 'mcp-a,mcp-b',
      NEXOWIRE_AGENT_TOKENS: 'agent-a,agent-b',
    },
    process.cwd(),
  );
  assert.throws(() => assertSafeRemoteBinding(config));
  assert.doesNotThrow(() =>
    assertSafeRemoteBinding({
      ...config,
      allowInsecureRemote: true,
    }),
  );
});

test('TLS certificate and key paths must be configured together', () => {
  assert.throws(() =>
    loadConfig(
      {
        NEXOWIRE_TLS_CERT_FILE: 'cert.pem',
      },
      process.cwd(),
    ),
  );
  assert.throws(() =>
    loadConfig(
      {
        NEXOWIRE_TLS_KEY_FILE: 'key.pem',
      },
      process.cwd(),
    ),
  );

  const config = loadConfig(
    {
      NEXOWIRE_TLS_CERT_FILE: 'cert.pem',
      NEXOWIRE_TLS_KEY_FILE: 'key.pem',
    },
    process.cwd(),
  );
  assert.equal(config.tlsCertFile, 'cert.pem');
  assert.equal(config.tlsKeyFile, 'key.pem');
});

test('insecure remote override accepts common boolean spellings', () => {
  for (const value of ['1', 'true', 'yes', 'on']) {
    const config = loadConfig(
      {
        NEXOWIRE_ALLOW_INSECURE_REMOTE: value,
      },
      process.cwd(),
    );
    assert.equal(config.allowInsecureRemote, true);
  }
});

test('persisted auth availability can satisfy remote credential requirement', () => {
  const config = loadConfig(
    {
      NEXOWIRE_HTTP_HOST: '0.0.0.0',
      NEXOWIRE_HTTP_PORT: '43110',
      NEXOWIRE_ALLOW_INSECURE_REMOTE: '1',
    },
    process.cwd(),
  );

  assert.throws(() => assertSafeRemoteBinding(config));
  assert.doesNotThrow(() =>
    assertSafeRemoteBinding(config, {
      mcp: true,
      agent: true,
    }),
  );
  assert.throws(() =>
    assertSafeRemoteBinding(config, {
      mcp: true,
      agent: false,
    }),
  );
});

test('OIDC config requires issuer and audience together and maps scoped claims', () => {
  assert.throws(() =>
    loadConfig(
      {
        NEXOWIRE_OIDC_ISSUER: 'https://identity.example.test',
      },
      process.cwd(),
    ),
  );
  assert.throws(() =>
    loadConfig(
      {
        NEXOWIRE_OIDC_AUDIENCE: 'nexowire',
      },
      process.cwd(),
    ),
  );

  const config = loadConfig(
    {
      NEXOWIRE_OIDC_ISSUER: 'https://identity.example.test/',
      NEXOWIRE_OIDC_AUDIENCE: 'nexowire-chatgpt',
      NEXOWIRE_OIDC_JWKS_URI:
        'https://identity.example.test/custom-jwks',
      NEXOWIRE_OIDC_ROLE_CLAIM: 'role',
      NEXOWIRE_OIDC_TOOLS_CLAIM: 'tools',
      NEXOWIRE_OIDC_DEVICE_IDS_CLAIM: 'devices',
      NEXOWIRE_OIDC_ROUTING_POLICIES_CLAIM: 'routes',
      NEXOWIRE_OIDC_CLOCK_SKEW_SECONDS: '45',
    },
    process.cwd(),
  );

  assert.deepEqual(config.oidc, {
    issuer: 'https://identity.example.test/',
    audience: 'nexowire-chatgpt',
    jwksUri: 'https://identity.example.test/custom-jwks',
    roleClaim: 'role',
    toolsClaim: 'tools',
    deviceIdsClaim: 'devices',
    routingPoliciesClaim: 'routes',
    clockSkewSeconds: 45,
  });

  assert.throws(() =>
    loadConfig(
      {
        NEXOWIRE_OIDC_ISSUER: 'https://identity.example.test',
        NEXOWIRE_OIDC_AUDIENCE: 'nexowire',
        NEXOWIRE_OIDC_CLOCK_SKEW_SECONDS: '301',
      },
      process.cwd(),
    ),
  );
});

test('external OIDC identity may satisfy MCP side of non-loopback auth availability', () => {
  const config = loadConfig(
    {
      NEXOWIRE_HTTP_HOST: '0.0.0.0',
      NEXOWIRE_HTTP_PORT: '43110',
      NEXOWIRE_ALLOW_INSECURE_REMOTE: '1',
      NEXOWIRE_OIDC_ISSUER: 'https://identity.example.test',
      NEXOWIRE_OIDC_AUDIENCE: 'nexowire-chatgpt',
      NEXOWIRE_AGENT_TOKEN: 'agent-secret',
    },
    process.cwd(),
  );

  assert.doesNotThrow(() =>
    assertSafeRemoteBinding(config, {
      mcp: Boolean(config.oidc),
      agent: true,
    }),
  );
});
