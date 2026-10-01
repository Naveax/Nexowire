import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { NexowireConfig } from '../src/config.js';
import { evaluateDeploymentReadiness } from '../src/security/deployment-readiness.js';

function config(
  root: string,
  overrides: Partial<NexowireConfig> = {},
): NexowireConfig {
  return {
    host: '127.0.0.1',
    port: 43110,
    stateDir: root,
    skillsDir: path.join(process.cwd(), 'skills'),
    ...overrides,
  };
}

test('local deployment can be healthy while remaining intentionally not remote-ready', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-doctor-local-'),
  );
  try {
    const report = await evaluateDeploymentReadiness(
      config(root),
      {
        env: {},
        now: Date.UTC(2026, 9, 1),
      },
    );

    assert.equal(report.mode, 'local');
    assert.equal(report.ready, true);
    assert.equal(report.remoteReady, false);
    assert.equal(report.summary.fail, 0);
    assert.equal(
      report.checks.find(
        (check) => check.id === 'bind-address',
      )?.status,
      'warn',
    );
    assert.equal(
      report.checks.find(
        (check) => check.id === 'mcp-authentication',
      )?.status,
      'warn',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('remote readiness fails closed without client and native-agent authentication', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-doctor-remote-'),
  );
  try {
    const report = await evaluateDeploymentReadiness(
      config(root, {
        host: '0.0.0.0',
        allowInsecureRemote: true,
      }),
      {
        env: {},
        now: Date.UTC(2026, 9, 1),
      },
    );

    assert.equal(report.mode, 'remote');
    assert.equal(report.ready, false);
    assert.equal(report.remoteReady, false);
    assert.equal(
      report.checks.find(
        (check) => check.id === 'mcp-authentication',
      )?.status,
      'fail',
    );
    assert.equal(
      report.checks.find(
        (check) => check.id === 'agent-authentication',
      )?.status,
      'fail',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('explicit remote plaintext remains a warning and is never production remote-ready', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-doctor-insecure-'),
  );
  try {
    const report = await evaluateDeploymentReadiness(
      config(root, {
        host: '0.0.0.0',
        allowInsecureRemote: true,
        mcpBearerTokens: ['mcp-secret'],
        agentTokens: ['agent-secret'],
      }),
      {
        env: {
          NEXOWIRE_MCP_BEARER_TOKEN: 'mcp-secret',
          NEXOWIRE_AGENT_TOKEN: 'agent-secret',
        },
        now: Date.UTC(2026, 9, 1),
      },
    );

    assert.equal(report.ready, true);
    assert.equal(report.remoteReady, false);
    assert.equal(
      report.checks.find(
        (check) => check.id === 'transport-tls',
      )?.status,
      'warn',
    );

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('mcp-secret'), false);
    assert.equal(serialized.includes('agent-secret'), false);
    assert.deepEqual(
      report.checks.find(
        (check) => check.id === 'secret-sources',
      )?.details?.mechanisms,
      ['inline-env'],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stored credentials and HTTPS OIDC are represented without credential payloads', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-doctor-auth-'),
  );
  try {
    const report = await evaluateDeploymentReadiness(
      config(root, {
        oidc: {
          issuer: 'https://identity.example.test',
          audience: 'nexowire',
        },
      }),
      {
        credentials: {
          hasUsable(scope) {
            return scope === 'agent';
          },
        },
        env: {},
        now: Date.UTC(2026, 9, 1),
      },
    );

    const mcp = report.checks.find(
      (check) => check.id === 'mcp-authentication',
    );
    const agent = report.checks.find(
      (check) => check.id === 'agent-authentication',
    );
    const oidc = report.checks.find(
      (check) => check.id === 'external-identity',
    );

    assert.equal(mcp?.status, 'pass');
    assert.equal(mcp?.details?.externalOidcConfigured, true);
    assert.equal(agent?.status, 'pass');
    assert.equal(
      agent?.details?.storedCredentialAvailable,
      true,
    );
    assert.equal(oidc?.status, 'pass');
    assert.deepEqual(oidc?.details, {
      issuerProtocol: 'https:',
      audienceConfigured: true,
      customJwksUri: false,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('--remote semantics can reject a loopback-only deployment even when local checks pass', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-doctor-require-remote-'),
  );
  try {
    const report = await evaluateDeploymentReadiness(
      config(root, {
        mcpBearerTokens: ['mcp'],
        agentTokens: ['agent'],
      }),
      {
        env: {},
        requireRemote: true,
      },
    );

    assert.equal(report.ready, false);
    assert.equal(report.remoteReady, false);
    assert.equal(
      report.checks.find(
        (check) => check.id === 'bind-address',
      )?.status,
      'fail',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
