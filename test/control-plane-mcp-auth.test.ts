import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneMcpClient } from '../src/hub/control-plane-mcp-auth.js';
import {
  authorizationGrant,
  resolveMcpAuthorization,
} from '../src/security/auth.js';

test('control-plane MCP client authenticates account and device scope', async () => {
  const requests: Array<{
    url: string;
    authorization: string | null;
    body: unknown;
  }> = [];

  const client = new ControlPlaneMcpClient({
    controlPlaneUrl: 'https://control.example.test',
    serviceToken: 'service-token-0123456789',
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        authorization:
          new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return Response.json({
        authenticated: true,
        accountId: 'acct-1',
        role: 'user',
        allowedDeviceIds: [
          'device-a',
          'device-b',
          'device-a',
        ],
        deviceAccessModes: {
          'device-a': 'full',
          'device-b': 'unexpected-value',
          'device-not-allowed': 'full',
        },
        autoSelectDevices: true,
        ownerDevices: [
          {id:'device-a',name:'Naveax',folderId:'folder-n'},
          {id:'device-b',name:'work-pc',folderId:null},
          {id:'device-not-allowed',name:'Other',folderId:null},
        ],
        ownerFolders: [{id:'folder-n',name:'Naveax'}],
      });
    },
  });

  assert.deepEqual(
    await client.authenticate(
      'Bearer nwx_mcp_access-token-1234567890',
    ),
    {
      accountId: 'acct-1',
      role: 'user',
      allowedDeviceIds: [
        'device-a',
        'device-b',
      ],
      deviceAccessModes: {
        'device-a': 'full',
        'device-b': 'safe',
      },
      autoSelectDevices: true,
      ownerDevices: [
        {id:'device-a',name:'Naveax',folderId:'folder-n'},
        {id:'device-b',name:'work-pc',folderId:null},
      ],
      ownerFolders: [{id:'folder-n',name:'Naveax'}],
    },
  );
  assert.deepEqual(requests, [
    {
      url:
        'https://control.example.test/api/v1/internal/mcp/authenticate',
      authorization:
        'Bearer service-token-0123456789',
      body: {
        accessToken:
          'nwx_mcp_access-token-1234567890',
      },
    },
  ]);
});

test('control-plane MCP access mode fails closed to SAFE when server omits mode data', async () => {
  const client = new ControlPlaneMcpClient({
    controlPlaneUrl: 'https://control.example.test',
    serviceToken: 'service-token-0123456789',
    fetchImpl: async () => Response.json({
      authenticated: true,
      accountId: 'acct-safe',
      role: 'user',
      allowedDeviceIds: ['device-safe'],
    }),
  });
  const authorization = await client.authenticate(
    'Bearer nwx_mcp_access-token-1234567890',
  );
  assert.deepEqual(authorization?.deviceAccessModes, {
    'device-safe': 'safe',
  });
  assert.equal(authorization?.autoSelectDevices,false);
  assert.deepEqual(authorization?.ownerDevices,[]);
  assert.deepEqual(authorization?.ownerFolders,[]);
});

test('control-plane MCP auth becomes a normal target-restricted authorization grant', async () => {
  const authorization = await resolveMcpAuthorization(
    'Bearer nwx_mcp_access-token-1234567890',
    [],
    undefined,
    undefined,
    async () => ({
      accountId: 'acct-1',
      role: 'user',
      allowedDeviceIds: ['device-a'],
    }),
  );

  assert.ok(authorization);
  assert.equal(authorization?.kind, 'control-plane');
  assert.deepEqual(
    authorizationGrant(authorization),
    {
      role: 'user',
      allowedDeviceIds: ['device-a'],
    },
  );
});

test('control-plane MCP client charges usage and fails closed on invalid replies', async () => {
  let call = 0;
  const client = new ControlPlaneMcpClient({
    controlPlaneUrl: 'https://control.example.test',
    serviceToken: 'service-token-0123456789',
    fetchImpl: async (input, init) => {
      call++;
      assert.equal(
        String(input),
        'https://control.example.test/api/v1/internal/usage/charge',
      );
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer service-token-0123456789',
      );
      if (call === 1) {
        return Response.json({
          status: 'charged',
          chargedCredits: 5,
          remainingCredits: 95,
          reason: null,
        });
      }
      return Response.json({ nonsense: true });
    },
  });

  assert.deepEqual(
    await client.chargeTool({
      accountId: 'acct-1',
      eventId: 'event-1',
      toolName: 'windows_private_desktop_start',
    }),
    {
      status: 'charged',
      chargedCredits: 5,
      remainingCredits: 95,
      reason: null,
    },
  );
  assert.equal(
    await client.chargeTool({
      accountId: 'acct-1',
      eventId: 'event-2',
      toolName: 'machine_health',
    }),
    undefined,
  );
});

test('malformed hosted bearer never reaches control plane', async () => {
  let calls = 0;
  const client = new ControlPlaneMcpClient({
    controlPlaneUrl: 'https://control.example.test',
    serviceToken: 'service-token-0123456789',
    fetchImpl: async () => {
      calls++;
      return Response.json({});
    },
  });

  assert.equal(
    await client.authenticate('Bearer not-hosted'),
    undefined,
  );
  assert.equal(calls, 0);
});

test('AUTO consent and revocation are read on each independent OAuth authentication request',async()=>{
  let enabled = false;
  let requests = 0;
  const client = new ControlPlaneMcpClient({
    controlPlaneUrl:'https://control.example.test',
    serviceToken:'service-token-0123456789',
    fetchImpl:async()=>{
      requests++;
      return Response.json({
        authenticated:true,accountId:'owner-1',role:'user',
        allowedDeviceIds:['device-a'],
        autoSelectDevices:enabled,
        ownerDevices:[{id:'device-a',name:'Naveax',folderId:null}],
        ownerFolders:[],
      });
    },
  });
  const credential='Bearer nwx_mcp_access-token-1234567890';
  assert.equal((await client.authenticate(credential))?.autoSelectDevices,false);
  enabled=true;
  assert.equal((await client.authenticate(credential))?.autoSelectDevices,true);
  enabled=false;
  assert.equal((await client.authenticate(credential))?.autoSelectDevices,false);
  assert.equal(requests,3);
});

test('AUTO and owner folder payloads fail closed against malformed or foreign metadata',async()=>{
  const client=new ControlPlaneMcpClient({
    controlPlaneUrl:'https://control.example.test',
    serviceToken:'service-token-0123456789',
    fetchImpl:async()=>Response.json({
      authenticated:true,accountId:'owner-1',role:'user',
      allowedDeviceIds:['device-a'],
      autoSelectDevices:'true',
      ownerDevices:[
        {id:'device-a',name:'Naveax',folderId:'allowed-folder'},
        {id:'other-owner-device',name:'Secret',folderId:null},
        {id:'device-a',name:'Duplicate',folderId:'allowed-folder'},
        {id:'device-bad',name:'Invalid\u0000',folderId:null},
      ],
      ownerFolders:[
        {id:'allowed-folder',name:'Maxi'},
        {id:'allowed-folder',name:'Duplicate'},
        {id:'evil',name:'Injected\u000aFolder'},
      ],
    }),
  });
  const auth=await client.authenticate('Bearer nwx_mcp_access-token-1234567890');
  assert.equal(auth?.autoSelectDevices,false);
  assert.deepEqual(auth?.ownerDevices,[{id:'device-a',name:'Naveax',folderId:'allowed-folder'}]);
  assert.deepEqual(auth?.ownerFolders,[{id:'allowed-folder',name:'Maxi'}]);
});
