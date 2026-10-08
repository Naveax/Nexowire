import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBroker } from '../src/core/agent-broker.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';
import { DeviceAliasStore } from '../src/devices/alias-store.js';
import { DeviceRoutingPolicyStore } from '../src/devices/routing-policy-store.js';
import { DeviceGroupStore } from '../src/devices/group-store.js';
import { createNexowireMcpServer } from '../src/mcp/create-server.js';
import type {
  Provider,
  ProviderExecutionRequest,
  ProviderHealth,
  ProviderTarget,
} from '../src/protocol/provider.js';
import type { ExecutionResult } from '../src/protocol/result.js';
import type { BearerAuthorization } from '../src/security/auth.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { WorkspaceStore } from '../src/workspace/store.js';

class TargetProvider implements Provider {
  readonly id = 'target-test';
  readonly priority = 100;

  constructor(private readonly targets: ProviderTarget[]) {}

  async health(): Promise<ProviderHealth> {
    return { ok: true, latencyMs: 1 };
  }

  async listTargets(): Promise<ProviderTarget[]> {
    return this.targets.map((target) => ({
      ...target,
      capabilities: [...target.capabilities],
    }));
  }

  async execute(
    request: ProviderExecutionRequest,
  ): Promise<ExecutionResult> {
    return {
      ok: true,
      data: {
        executedTargetId: request.targetId,
        capability: request.capability,
      },
      meta: {
        providerId: this.id,
        targetId: request.targetId,
        capability: request.capability,
        durationMs: 1,
        ...(request.requestId
          ? { requestId: request.requestId }
          : {}),
      },
    };
  }
}

async function withScopedClient(
  authorization: BearerAuthorization,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-target-scope-'),
  );
  const providers = new ProviderRegistry();
  providers.register(
    new TargetProvider([
      {
        id: 'desktop',
        name: 'Desktop',
        providerId: 'target-test',
        platform: 'win32',
        online: true,
        capabilities: ['machine.snapshot'],
      },
      {
        id: 'laptop',
        name: 'Laptop',
        providerId: 'target-test',
        platform: 'linux',
        online: true,
        capabilities: ['machine.snapshot'],
      },
    ]),
  );

  const aliases = new DeviceAliasStore(root);
  const groups = new DeviceGroupStore(root);
  const routingPolicies = new DeviceRoutingPolicyStore(root);
  await Promise.all([
    aliases.initialize(),
    groups.initialize(),
    routingPolicies.initialize(),
  ]);
  await aliases.set('main-pc', 'desktop');
  await aliases.set('linux-box', 'laptop');
  await routingPolicies.set('windows-route', {
    selection: 'unique_only',
    platform: 'win32',
    requiredCapabilities: ['machine.snapshot'],
  });
  await routingPolicies.set('linux-route', {
    selection: 'unique_only',
    platform: 'linux',
    requiredCapabilities: ['machine.snapshot'],
  });

  const mcp = createNexowireMcpServer({
    broker: new AgentBroker(),
    providers,
    aliases,
    groups,
    routingPolicies,
    toolAuthorization: authorization,
    workspaces: new WorkspaceStore(root),
    skills: new SkillRegistry(path.join(process.cwd(), 'skills')),
  });
  const client = new Client({
    name: 'target-scope-test',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      mcp.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    await run(client);
  } finally {
    await client.close();
    await mcp.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('direct device scopes filter discovery metadata and execution targets', async () => {
  await withScopedClient(
    {
      kind: 'stored',
      scope: 'mcp',
      credential: {
        id: 'credentialdirect',
        scope: 'mcp',
        createdAt: '2026-09-30T12:00:00.000Z',
        allowedDeviceIds: ['desktop'],
      },
    },
    async (client) => {
      const devices = await client.callTool({
        name: 'devices_list',
        arguments: {},
      });
      const deviceData = devices.structuredContent as {
        devices?: Array<{ id: string }>;
      };
      assert.deepEqual(
        deviceData.devices?.map((device) => device.id),
        ['desktop'],
      );

      const aliases = await client.callTool({
        name: 'device_alias_list',
        arguments: {},
      });
      const aliasData = aliases.structuredContent as {
        aliases?: Array<{ alias: string; deviceId: string }>;
      };
      assert.deepEqual(
        aliasData.aliases?.map((entry) => ({
          alias: entry.alias,
          deviceId: entry.deviceId,
        })),
        [{ alias: 'main-pc', deviceId: 'desktop' }],
      );

      // Credential scope is a restriction, not user approval to auto-select.
      const auto = await client.callTool({
        name: 'machine_snapshot',
        arguments: {},
      });
      assert.equal('isError' in auto ? auto.isError : false, true);
      assert.equal(
        (auto.structuredContent as {error?: {code?: string}}).error?.code,
        'MCP_TARGET_NOT_AUTHORIZED',
      );
      const explicit = await client.callTool({
        name: 'machine_snapshot', arguments: {device_id: 'desktop'},
      });
      assert.equal(
        (explicit.structuredContent as {data?: {executedTargetId?: string}}).data?.executedTargetId,
        'desktop',
      );

      const denied = await client.callTool({
        name: 'machine_snapshot',
        arguments: { device_id: 'laptop' },
      });
      assert.equal('isError' in denied ? denied.isError : false, true);
      const deniedData = denied.structuredContent as {
        error?: { code?: string };
      };
      assert.equal(
        deniedData.error?.code,
        'MCP_TARGET_NOT_AUTHORIZED',
      );

      const policies = await client.callTool({
        name: 'device_route_policy_list',
        arguments: {},
      });
      assert.deepEqual(
        (policies.structuredContent as {
          policies?: unknown[];
        }).policies,
        [],
      );
    },
  );
});

test('deterministic route scopes grant only the currently selected route target', async () => {
  await withScopedClient(
    {
      kind: 'stored',
      scope: 'mcp',
      credential: {
        id: 'credentialroute',
        scope: 'mcp',
        createdAt: '2026-09-30T12:00:00.000Z',
        allowedRoutingPolicies: ['linux-route'],
      },
    },
    async (client) => {
      const devices = await client.callTool({
        name: 'devices_list',
        arguments: {},
      });
      assert.deepEqual(
        (devices.structuredContent as {
          devices?: Array<{ id: string }>;
        }).devices?.map((device) => device.id),
        ['laptop'],
      );

      const policies = await client.callTool({
        name: 'device_route_policy_list',
        arguments: {},
      });
      assert.deepEqual(
        (policies.structuredContent as {
          policies?: Array<{ name: string }>;
        }).policies?.map((policy) => policy.name),
        ['linux-route'],
      );

      const resolved = await client.callTool({
        name: 'device_route_policy_resolve',
        arguments: { name: 'linux-route' },
      });
      assert.equal(
        (resolved.structuredContent as {
          selected?: { id?: string };
        }).selected?.id,
        'laptop',
      );

      const unauthorizedRoute = await client.callTool({
        name: 'device_route_policy_resolve',
        arguments: { name: 'windows-route' },
      });
      assert.equal(
        'isError' in unauthorizedRoute
          ? unauthorizedRoute.isError
          : false,
        true,
      );
      assert.equal(
        (unauthorizedRoute.structuredContent as {
          error?: { code?: string };
        }).error?.code,
        'MCP_ROUTE_NOT_AUTHORIZED',
      );

      // Credential scope is a restriction, not user approval to auto-select.
      const auto = await client.callTool({
        name: 'machine_snapshot',
        arguments: {},
      });
      assert.equal('isError' in auto ? auto.isError : false, true);
      assert.equal(
        (auto.structuredContent as {error?: {code?: string}}).error?.code,
        'MCP_TARGET_NOT_AUTHORIZED',
      );
      const explicit = await client.callTool({
        name: 'machine_snapshot', arguments: {device_id: 'laptop'},
      });
      assert.equal(
        (explicit.structuredContent as {data?: {executedTargetId?: string}}).data?.executedTargetId,
        'laptop',
      );

      const denied = await client.callTool({
        name: 'machine_snapshot',
        arguments: { device_id: 'desktop' },
      });
      assert.equal('isError' in denied ? denied.isError : false, true);
    },
  );
});
