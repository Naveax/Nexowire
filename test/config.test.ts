import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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

test('hub config can consume injected platform-backed secret references', () => {
  const calls: Array<{ kind: string; name: string | undefined; purpose: string }> = [];
  const config = loadConfig(
    {
      NEXOWIRE_MCP_BEARER_TOKEN_PLATFORM_NAME: 'mcp-primary',
      NEXOWIRE_MCP_BEARER_TOKENS_PLATFORM_NAME: 'mcp-rotation',
      NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME: 'agent-primary',
      NEXOWIRE_AGENT_TOKENS_PLATFORM_NAME: 'agent-rotation',
    },
    process.cwd(),
    {
      platformSingle: (name, purpose) => {
        calls.push({ kind: 'single', name, purpose });
        if (!name) return undefined;
        return purpose.startsWith('mcp')
          ? 'mcp-platform'
          : 'agent-platform';
      },
      platformList: (name, purpose) => {
        calls.push({ kind: 'list', name, purpose });
        if (!name) return undefined;
        return purpose.startsWith('mcp')
          ? 'mcp-old,mcp-next'
          : 'agent-old,agent-next';
      },
    },
  );

  assert.equal(config.mcpBearerToken, 'mcp-platform');
  assert.deepEqual(config.mcpBearerTokens, [
    'mcp-platform',
    'mcp-old',
    'mcp-next',
  ]);
  assert.equal(config.agentToken, 'agent-platform');
  assert.deepEqual(config.agentTokens, [
    'agent-platform',
    'agent-old',
    'agent-next',
  ]);
  assert.deepEqual(calls, [
    {
      kind: 'single',
      name: 'mcp-primary',
      purpose: 'mcp-bearer-token',
    },
    {
      kind: 'single',
      name: 'agent-primary',
      purpose: 'agent-bearer-token',
    },
    {
      kind: 'list',
      name: 'mcp-rotation',
      purpose: 'mcp-bearer-token-list',
    },
    {
      kind: 'list',
      name: 'agent-rotation',
      purpose: 'agent-bearer-token-list',
    },
  ]);
});

test('skills directory supports explicit override and bundled fallback', () => {
  const explicit = loadConfig(
    {
      NEXOWIRE_SKILLS_DIR: '/tmp/nexowire-custom-skills',
    },
    '/tmp/unrelated-working-directory',
    {
      platformSingle: () => undefined,
      platformList: () => undefined,
    },
  );
  assert.equal(
    explicit.skillsDir,
    '/tmp/nexowire-custom-skills',
  );

  const fallback = loadConfig(
    {},
    '/tmp/unrelated-working-directory',
    {
      platformSingle: () => undefined,
      platformList: () => undefined,
    },
  );
  assert.equal(
    path.basename(fallback.skillsDir),
    'skills',
  );
  assert.notEqual(
    fallback.skillsDir,
    path.join('/tmp/unrelated-working-directory', 'skills'),
  );
});


test('control-plane device auth config requires URL and service token together', () => {
  assert.throws(() =>
    loadConfig(
      {
        NEXOWIRE_CONTROL_PLANE_URL:
          'https://control.example.test',
      },
      process.cwd(),
    ),
  );
  assert.throws(() =>
    loadConfig(
      {
        NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:
          'service-token-0123456789',
      },
      process.cwd(),
    ),
  );

  const config = loadConfig(
    {
      NEXOWIRE_CONTROL_PLANE_URL:
        'https://control.example.test',
      NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:
        'service-token-0123456789',
      NEXOWIRE_CONTROL_PLANE_AUTH_TIMEOUT_MS: '2500',
    },
    process.cwd(),
  );

  assert.deepEqual(config.controlPlaneAgentAuth, {
    url: 'https://control.example.test',
    serviceToken: 'service-token-0123456789',
    timeoutMs: 2500,
  });

  assert.throws(() =>
    loadConfig(
      {
        NEXOWIRE_CONTROL_PLANE_URL:
          'https://control.example.test',
        NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:
          'service-token-0123456789',
        NEXOWIRE_CONTROL_PLANE_AUTH_TIMEOUT_MS: '249',
      },
      process.cwd(),
    ),
  );
});

test('control-plane device auth can satisfy native-agent remote auth availability', () => {
  const config = loadConfig(
    {
      NEXOWIRE_HTTP_HOST: '0.0.0.0',
      NEXOWIRE_HTTP_PORT: '43110',
      NEXOWIRE_ALLOW_INSECURE_REMOTE: '1',
      NEXOWIRE_MCP_BEARER_TOKEN: 'mcp-secret',
      NEXOWIRE_CONTROL_PLANE_URL:
        'https://control.example.test',
      NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:
        'service-token-0123456789',
    },
    process.cwd(),
  );

  assert.doesNotThrow(() =>
    assertSafeRemoteBinding(config, {
      mcp: true,
      agent: Boolean(config.controlPlaneAgentAuth),
    }),
  );
});


test('public MCP resource URL is validated independently from agent control-plane auth', () => {
  const config = loadConfig(
    {
      NEXOWIRE_MCP_RESOURCE_URL:
        'https://mcp.example.test/mcp',
    },
    process.cwd(),
  );
  assert.equal(
    config.mcpResourceUrl,
    'https://mcp.example.test/mcp',
  );

  const loopback = loadConfig(
    {
      NEXOWIRE_MCP_RESOURCE_URL:
        'http://127.0.0.1:43110/mcp',
    },
    process.cwd(),
  );
  assert.equal(
    loopback.mcpResourceUrl,
    'http://127.0.0.1:43110/mcp',
  );

  for (const invalid of [
    'http://mcp.example.test/mcp',
    'https://mcp.example.test/not-mcp',
    'https://user:pass@mcp.example.test/mcp',
    'https://mcp.example.test/mcp?token=nope',
  ]) {
    assert.throws(() =>
      loadConfig(
        {
          NEXOWIRE_MCP_RESOURCE_URL: invalid,
        },
        process.cwd(),
      ),
    );
  }
});


test('control-plane service token resolves from a platform-backed protected source', () => {
  const calls: Array<{
    name: string | undefined;
    purpose: string;
  }> = [];

  const config = loadConfig(
    {
      NEXOWIRE_CONTROL_PLANE_URL:
        'https://control.example.test',
      NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_PLATFORM_NAME:
        'control-plane-service',
    },
    process.cwd(),
    {
      platformSingle: (name, purpose) => {
        calls.push({ name, purpose });
        if (
          name === 'control-plane-service' &&
          purpose === 'control-plane-service-token'
        ) {
          return 'service-token-from-platform';
        }
        return undefined;
      },
      platformList: () => undefined,
    },
  );

  assert.deepEqual(config.controlPlaneAgentAuth, {
    url: 'https://control.example.test',
    serviceToken: 'service-token-from-platform',
  });
  assert.ok(
    calls.some(
      (call) =>
        call.name === 'control-plane-service' &&
        call.purpose ===
          'control-plane-service-token',
    ),
  );
});

test('control-plane service token sources fail closed on conflicting values', () => {
  assert.throws(
    () =>
      loadConfig(
        {
          NEXOWIRE_CONTROL_PLANE_URL:
            'https://control.example.test',
          NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:
            'inline-service-token',
          NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_PLATFORM_NAME:
            'control-plane-service',
        },
        process.cwd(),
        {
          platformSingle: (name, purpose) =>
            name === 'control-plane-service' &&
            purpose ===
              'control-plane-service-token'
              ? 'different-platform-token'
              : undefined,
          platformList: () => undefined,
        },
      ),
    /multiple secret sources with different contents/i,
  );
});
