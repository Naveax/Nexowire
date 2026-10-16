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
import { IdempotencyStore } from '../src/operations/idempotency-store.js';
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
  seed?: (store: IdempotencyStore) => Promise<void>,
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

  const idempotency = new IdempotencyStore(root);
  if (seed) await seed(idempotency);
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
  // A workspace alias may collide with an actual OAuth owner's device name.
  // Reserved folder syntax is already rejected by DeviceAliasStore's regex.
  await aliases.set('Naveax', 'laptop');
  await aliases.set('work-pc', 'desktop');
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
    idempotency,
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

test('idempotency status lookups cannot disclose records for unpermitted devices', async () => {
  await withScopedClient(
    {
      kind: 'stored',
      scope: 'mcp',
      credential: {
        id: 'credential-idempotency-scoped',
        scope: 'mcp',
        role: 'operator',
        createdAt: '2026-09-30T12:00:00.000Z',
        allowedDeviceIds: ['desktop'],
      },
    },
    async (client) => {
      for (const argumentsInput of [{ limit: 10 }, { key: 'scope-laptop' }]) {
        const result = await client.callTool({
          name: 'operations_idempotency_list',
          arguments: argumentsInput,
        });
        const content = result.structuredContent as {
          records?: Array<{ key: string; targetId: string }>;
        };
        assert.deepEqual(
          content.records?.map((record) => record.key),
          argumentsInput.key ? [] : ['scope-desktop'],
        );
      }
      const permitted = await client.callTool({
        name: 'operations_idempotency_list',
        arguments: { key: 'scope-desktop' },
      });
      const records = (permitted.structuredContent as {
        records?: Array<{ key: string; targetId: string; status: string }>;
      }).records;
      assert.deepEqual(records?.map((record) => record.targetId), ['desktop']);
      assert.equal(records?.[0]?.status, 'succeeded');
    },
    async (store) => {
      for (const [key, targetId, digit] of [
        ['scope-desktop', 'desktop', '1'],
        ['scope-laptop', 'laptop', '2'],
      ] as const) {
        await store.begin({
          key, targetId, fingerprint: digit.repeat(64), capability: 'files.write',
        });
        await store.complete(key, 'succeeded');
      }
    },
  );
});

test('offline explicitly authorized device retains scoped idempotency history', async () => {
  await withScopedClient({
    kind: 'stored',
    scope: 'mcp',
    credential: {
      id: 'credential-idempotency-offline',
      scope: 'mcp',
      role: 'operator',
      createdAt: '2026-09-30T12:00:00.000Z',
      allowedDeviceIds: ['desktop', 'offline-device'],
    },
  }, async (client) => {
    const listed = await client.callTool({
      name: 'operations_idempotency_list',
      arguments: { limit: 20 },
    });
    const records = (listed.structuredContent as {
      records: Array<{ key: string; targetId: string; status: string }>
    }).records;
    assert.deepEqual(records.map((record) => record.key).sort(), [
      'offline-operation', 'online-operation',
    ]);
    const single = await client.callTool({
      name: 'operations_idempotency_list',
      arguments: { limit: 1 },
    });
    assert.deepEqual((single.structuredContent as {
      records: Array<{ key: string }>
    }).records.map((record) => record.key), ['offline-operation']);
    assert.equal(records.find((record) => record.key === 'offline-operation')?.status,
      'unknown');
    const exact = await client.callTool({
      name: 'operations_idempotency_list',
      arguments: { key: 'offline-operation' },
    });
    assert.deepEqual((exact.structuredContent as {
      records: Array<{ targetId: string }>
    }).records.map((record) => record.targetId), ['offline-device']);
    const foreign = await client.callTool({
      name: 'operations_idempotency_list',
      arguments: { key: 'foreign-operation' },
    });
    assert.deepEqual((foreign.structuredContent as { records: unknown[] }).records, []);
  }, async (store) => {
    for (const [key, targetId, digit, status] of [
      ['online-operation', 'desktop', '1', 'succeeded'],
      ['offline-operation', 'offline-device', '2', 'unknown'],
      ['foreign-operation', 'laptop', '3', 'succeeded'],
    ] as const) {
      if (key === 'offline-operation') {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await store.begin({ key, targetId, fingerprint: digit.repeat(64),
        capability: 'files.write' });
      await store.complete(key, status);
    }
  });
});

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
        [{ alias: 'main-pc', deviceId: 'desktop' }, { alias: 'work-pc', deviceId: 'desktop' }],
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

test('owner AUTO is denied by default even when the only provisioned device is online', async () => {
  await withScopedClient({
    kind:'control-plane',scope:'mcp',accountId:'owner-1',role:'user',
    allowedDeviceIds:['desktop'],autoSelectDevices:false,
    ownerDevices:[{id:'desktop',name:'Naveax',folderId:null}],ownerFolders:[],
  },async client=>{
    const denied=await client.callTool({name:'machine_snapshot',arguments:{}});
    assert.equal(denied.isError,true);
    assert.equal((denied.structuredContent as {error?:{code:string}}).error?.code,'MCP_TARGET_NOT_AUTHORIZED');
    const named=await client.callTool({name:'machine_snapshot',arguments:{device_id:'Naveax'}});
    assert.equal((named.structuredContent as {data?:{executedTargetId:string}}).data?.executedTargetId,'desktop');
  });
});

test('fresh owner-approved AUTO selects only the single provisioned device',async()=>{
  await withScopedClient({
    kind:'control-plane',scope:'mcp',accountId:'owner-1',role:'user',
    allowedDeviceIds:['desktop'],autoSelectDevices:true,
    ownerDevices:[{id:'desktop',name:'Naveax',folderId:'f1'}],
    ownerFolders:[{id:'f1',name:'Naveax'}],
  },async client=>{
    const directory=await client.callTool({name:'devices_list',arguments:{}});
    assert.equal((directory.structuredContent as {autoSelectionEnabled?:boolean}).autoSelectionEnabled,true);
    assert.deepEqual((directory.structuredContent as {folders?:unknown[]}).folders,[{id:'f1',name:'Naveax',deviceIds:['desktop']}]);
    const selected=await client.callTool({name:'machine_snapshot',arguments:{}});
    assert.equal((selected.structuredContent as {data?:{executedTargetId:string}}).data?.executedTargetId,'desktop');
    const folderSelected=await client.callTool({name:'machine_snapshot',arguments:{device_id:'folder:Naveax'}});
    assert.equal((folderSelected.structuredContent as {data?:{executedTargetId:string}}).data?.executedTargetId,'desktop');
    const foreign=await client.callTool({name:'machine_snapshot',arguments:{device_id:'folder:Foreign'}});
    assert.equal(foreign.isError,true);
    assert.equal((foreign.structuredContent as {error?:{code:string}}).error?.code,'MCP_TARGET_NOT_AUTHORIZED');
  });
});

test('owner AUTO never guesses with two registered devices; named single-device folder resolves',async()=>{
  const auth: BearerAuthorization={
    kind:'control-plane',scope:'mcp',accountId:'owner-1',role:'user',
    allowedDeviceIds:['desktop','laptop'],autoSelectDevices:true,
    ownerDevices:[
      {id:'desktop',name:'Naveax',folderId:'f1'},
      {id:'laptop',name:'work-pc',folderId:'f2'},
    ],
    ownerFolders:[{id:'f1',name:'Naveax'},{id:'f2',name:'Work'}],
  };
  await withScopedClient(auth,async client=>{
    const noTarget=await client.callTool({name:'machine_snapshot',arguments:{}});
    assert.equal(noTarget.isError,true);
    const folder=await client.callTool({name:'machine_snapshot',arguments:{device_id:'folder:Work'}});
    assert.equal((folder.structuredContent as {data?:{executedTargetId:string}}).data?.executedTargetId,'laptop');
    const explicit=await client.callTool({name:'machine_snapshot',arguments:{device_id:'NAVEAX'}});
    assert.equal((explicit.structuredContent as {data?:{executedTargetId:string}}).data?.executedTargetId,'desktop');
  });
});

test('folder-only selection remains denied when AUTO is off, including a unique folder',async()=>{
  await withScopedClient({
    kind:'control-plane',scope:'mcp',accountId:'owner-1',role:'user',
    allowedDeviceIds:['desktop','laptop'],autoSelectDevices:false,
    ownerDevices:[
      {id:'desktop',name:'Naveax',folderId:'f1'},
      {id:'laptop',name:'work-pc',folderId:'f2'},
    ],
    ownerFolders:[{id:'f1',name:'Naveax'},{id:'f2',name:'Work'}],
  },async client=>{
    const denied=await client.callTool({name:'machine_snapshot',arguments:{device_id:'folder:Work'}});
    assert.equal(denied.isError,true);
    assert.equal((denied.structuredContent as {error?:{code:string}}).error?.code,'MCP_TARGET_NOT_AUTHORIZED');
    const explicit=await client.callTool({name:'machine_snapshot',arguments:{device_id:'work-pc'}});
    assert.equal((explicit.structuredContent as {data?:{executedTargetId:string}}).data?.executedTargetId,'laptop');
  });
});

test('ambiguous folder names, foreign devices and unexpected name collisions fail closed',async()=>{
  await withScopedClient({
    kind:'control-plane',scope:'mcp',accountId:'owner-1',role:'user',
    allowedDeviceIds:['desktop','laptop'],autoSelectDevices:true,
    ownerDevices:[
      {id:'desktop',name:'Same',folderId:'f1'},
      {id:'laptop',name:'same',folderId:'f2'},
      {id:'foreign-device',name:'foreign',folderId:'f1'},
    ],
    ownerFolders:[{id:'f1',name:'Maxi'},{id:'f2',name:'maxi'}],
  },async client=>{
    for(const identifier of ['Same','folder:Maxi','foreign','folder:Unknown']){
      const denied=await client.callTool({name:'machine_snapshot',arguments:{device_id:identifier}});
      assert.equal(denied.isError,true,identifier);
      assert.equal((denied.structuredContent as {error?:{code:string}}).error?.code,
        'MCP_TARGET_NOT_AUTHORIZED',identifier);
    }
  });
});

test('hosted OAuth devices_list includes account-owned empty folders without leaking foreign devices',async()=>{
  await withScopedClient({
    kind:'control-plane',scope:'mcp',accountId:'owner-1',role:'user',
    allowedDeviceIds:['desktop','laptop'],autoSelectDevices:true,
    ownerDevices:[
      {id:'desktop',name:'Naveax',folderId:'f1'},
      {id:'laptop',name:'work-pc',folderId:'f2'},
      {id:'foreign-device',name:'Other',folderId:'f1'},
    ],
    ownerFolders:[
      {id:'f1',name:'Naveax'},
      {id:'f2',name:'Work'},
      {id:'empty',name:'Empty'},
    ],
  },async client=>{
    const listed=await client.callTool({name:'devices_list',arguments:{}});
    assert.equal((listed.structuredContent as {autoSelectionEnabled?:boolean}).autoSelectionEnabled,true);
    assert.deepEqual((listed.structuredContent as {folders?:unknown[]}).folders,[
      {id:'f1',name:'Naveax',deviceIds:['desktop']},
      {id:'f2',name:'Work',deviceIds:['laptop']},
      {id:'empty',name:'Empty',deviceIds:[]},
    ]);
    const online=await client.callTool({name:'devices_list',arguments:{online_only:true}});
    assert.deepEqual((online.structuredContent as {folders?:unknown[]}).folders,[
      {id:'f1',name:'Naveax',deviceIds:['desktop']},
      {id:'f2',name:'Work',deviceIds:['laptop']},
      {id:'empty',name:'Empty',deviceIds:[]},
    ]);
  });
});
