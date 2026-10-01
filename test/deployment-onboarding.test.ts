import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { NexowireConfig } from '../src/config.js';
import { CredentialStore } from '../src/security/credential-store.js';
import {
  bootstrapDeploymentOnboarding,
  parseDeploymentOnboardingArgs,
  planDeploymentOnboarding,
} from '../src/security/deployment-onboarding.js';

function config(root: string): NexowireConfig {
  return {
    host: '127.0.0.1',
    port: 43110,
    stateDir: root,
    skillsDir: path.join(process.cwd(), 'skills'),
  };
}

test('deployment onboarding plan is non-mutating and secret-free', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-onboard-plan-'),
  );
  try {
    const store = new CredentialStore(root);
    await store.initialize();

    const report = await planDeploymentOnboarding(
      config(root),
      store,
    );

    assert.equal(report.mode, 'plan');
    assert.deepEqual(report.issued, []);
    assert.equal(report.existing.mcpUsable, false);
    assert.equal(report.existing.agentUsable, false);
    assert.equal(
      report.secretHandling.plaintextPersistedByNexowire,
      false,
    );
    assert.equal(report.secretHandling.tokensShownOnce, false);
    assert.equal(store.list().length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bootstrap issues one-time scoped credentials without persisting plaintext tokens', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-onboard-bootstrap-'),
  );
  try {
    const store = new CredentialStore(root);
    await store.initialize();

    const report = await bootstrapDeploymentOnboarding(
      config(root),
      store,
      {
        mcpRole: 'operator',
        mcpTtlDays: 7,
        agentTtlDays: 5,
        allowedTools: [
          'machine_*',
          'files_read',
          'machine_*',
        ],
        allowedDeviceIds: ['device-a'],
      },
    );

    assert.equal(report.mode, 'bootstrap');
    assert.equal(report.issued.length, 2);
    assert.equal(report.secretHandling.tokensShownOnce, true);
    assert.equal(report.existing.mcpUsable, false);
    assert.equal(report.existing.agentUsable, false);

    const mcp = report.issued.find(
      (entry) => entry.scope === 'mcp',
    );
    const agent = report.issued.find(
      (entry) => entry.scope === 'agent',
    );
    assert.ok(mcp);
    assert.ok(agent);
    assert.match(mcp.token, /^nwx1\.mcp\./);
    assert.match(agent.token, /^nwx1\.agent\./);
    assert.equal(mcp.credential.role, 'operator');
    assert.deepEqual(mcp.credential.allowedTools, [
      'files_read',
      'machine_*',
    ]);
    assert.deepEqual(mcp.credential.allowedDeviceIds, [
      'device-a',
    ]);

    const persisted = await fs.readFile(
      path.join(root, 'credentials.json'),
      'utf8',
    );
    assert.equal(persisted.includes(mcp.token), false);
    assert.equal(persisted.includes(agent.token), false);
    assert.match(persisted, /"tokenHash"/);

    assert.equal(
      store.authenticate('mcp', mcp.token)?.id,
      mcp.credential.id,
    );
    assert.equal(
      store.authenticate('agent', agent.token)?.id,
      agent.credential.id,
    );

    const second = await bootstrapDeploymentOnboarding(
      config(root),
      store,
    );
    assert.deepEqual(second.issued, []);
    assert.equal(second.existing.mcpUsable, true);
    assert.equal(second.existing.agentUsable, true);

    const forced = await bootstrapDeploymentOnboarding(
      config(root),
      store,
      { force: true },
    );
    assert.equal(forced.issued.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('onboarding argument parser preserves bounded scope options', () => {
  assert.deepEqual(
    parseDeploymentOnboardingArgs([
      'bootstrap',
      '--remote',
      '--mcp-role',
      'operator',
      '--mcp-ttl-days=14',
      '--agent-ttl-days',
      '10',
      '--allow-tool',
      'machine_*',
      '--allow-device=device-a',
      '--allow-route',
      'primary',
      '--force',
    ]),
    {
      action: 'bootstrap',
      options: {
        remote: true,
        force: true,
        mcpRole: 'operator',
        mcpTtlDays: 14,
        agentTtlDays: 10,
        allowedTools: ['machine_*'],
        allowedDeviceIds: ['device-a'],
        allowedRoutingPolicies: ['primary'],
      },
    },
  );
});

test('onboarding TTL validation fails closed', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-onboard-ttl-'),
  );
  try {
    const store = new CredentialStore(root);
    await store.initialize();
    await assert.rejects(
      () =>
        bootstrapDeploymentOnboarding(
          config(root),
          store,
          { mcpTtlDays: 0 },
        ),
      /between 1 and 365 days/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
