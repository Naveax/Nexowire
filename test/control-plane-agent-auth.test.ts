import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createControlPlaneAgentCredentialVerifier,
  createControlPlaneAgentPresenceReporter,
} from '../src/hub/control-plane-agent-auth.js';

test('control-plane agent verifier exchanges a device credential for a bound device id', async () => {
  let calls = 0;
  const verifier = createControlPlaneAgentCredentialVerifier({
    controlPlaneUrl: 'https://control.example.test/',
    serviceToken: 'service-token-0123456789',
    fetchImpl: async (input, init) => {
      calls++;
      assert.equal(
        String(input),
        'https://control.example.test/api/v1/internal/device/authenticate',
      );
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get('authorization'),
        'Bearer service-token-0123456789',
      );
      assert.deepEqual(
        JSON.parse(String(init?.body ?? '{}')),
        { credential: 'nwx_dev_credential-1234567890' },
      );
      return Response.json({
        authenticated: true,
        device: {
          deviceId:
            '11111111-1111-4111-8111-111111111111',
        },
      });
    },
  });

  assert.deepEqual(
    await verifier(
      'Bearer nwx_dev_credential-1234567890',
    ),
    {
      deviceId:
        '11111111-1111-4111-8111-111111111111',
    },
  );
  assert.equal(calls, 1);
});

test('control-plane agent verifier fails closed without sending malformed credentials', async () => {
  let calls = 0;
  const verifier = createControlPlaneAgentCredentialVerifier({
    controlPlaneUrl: 'https://control.example.test',
    serviceToken: 'service-token-0123456789',
    fetchImpl: async () => {
      calls++;
      throw new Error('must not be called');
    },
  });

  assert.equal(await verifier(undefined), undefined);
  assert.equal(
    await verifier('Bearer not-a-device-token'),
    undefined,
  );
  assert.equal(calls, 0);
});

test('control-plane agent verifier fails closed on remote errors', async () => {
  const verifier = createControlPlaneAgentCredentialVerifier({
    controlPlaneUrl: 'https://control.example.test',
    serviceToken: 'service-token-0123456789',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });

  assert.equal(
    await verifier(
      'Bearer nwx_dev_credential-1234567890',
    ),
    undefined,
  );
});


test('control-plane agent presence reporter posts bounded device state', async () => {
  const reporter = createControlPlaneAgentPresenceReporter({
    controlPlaneUrl: 'https://control.example.test/',
    serviceToken: 'service-token-0123456789',
    fetchImpl: async (input, init) => {
      assert.equal(
        String(input),
        'https://control.example.test/api/v1/internal/device/presence',
      );
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get('authorization'),
        'Bearer service-token-0123456789',
      );
      assert.deepEqual(
        JSON.parse(String(init?.body ?? '{}')),
        {
          deviceId:
            '11111111-1111-4111-8111-111111111111',
          online: true,
          at: '2026-10-04T13:36:15.338Z',
          agentVersion: '1.0.4',
          privilegeMode: 'broker',
          adminBridgeReady: true,
        },
      );
      return Response.json({ updated: true });
    },
  });

  assert.equal(
    await reporter({
      deviceId:
        '11111111-1111-4111-8111-111111111111',
      online: true,
      at: '2026-10-04T13:36:15.338Z',
      agentVersion: '1.0.4',
      privilegeMode: 'broker',
      adminBridgeReady: true,
    }),
    true,
  );
});

test('control-plane agent presence reporter fails soft on invalid input and remote errors', async () => {
  let calls = 0;
  const reporter = createControlPlaneAgentPresenceReporter({
    controlPlaneUrl: 'https://control.example.test',
    serviceToken: 'service-token-0123456789',
    fetchImpl: async () => {
      calls++;
      throw new Error('network down');
    },
  });

  assert.equal(
    await reporter({
      deviceId: '',
      online: true,
      at: '2026-10-04T13:36:15.338Z',
    }),
    false,
  );
  assert.equal(calls, 0);

  assert.equal(
    await reporter({
      deviceId:
        '11111111-1111-4111-8111-111111111111',
      online: false,
      at: '2026-10-04T13:36:16.338Z',
    }),
    false,
  );
  assert.equal(calls, 1);
});


test('control-plane verifier transports complete owner/device/epoch lease without inventing authority',async()=>{
  const leaseExpiresAtMs=Date.now()+60_000;
  const deviceId='device-authority-v206';
  const verify=createControlPlaneAgentCredentialVerifier({
    controlPlaneUrl:'https://control.example.test',
    serviceToken:'service-token-0123456789',
    fetchImpl:async()=>Response.json({authenticated:true,device:{
      deviceId,ownerAccountId:'owner-v206',authorizationEpoch:12,leaseExpiresAtMs,
    }}),
  });
  assert.deepEqual(await verify('Bearer nwx_dev_credential-1234567890'),{
    deviceId,ownerId:'owner-v206',authorizationEpoch:12,leaseExpiresAtMs,
  });
});

test('control-plane verifier rejects malformed or conflicting full authority proofs',async()=>{
  let response:Record<string,unknown>={};
  const verify=createControlPlaneAgentCredentialVerifier({
    controlPlaneUrl:'https://control.example.test',
    serviceToken:'service-token-0123456789',
    fetchImpl:async()=>Response.json({authenticated:true,device:response}),
  });
  const deviceId='device-authority-v206',ownerAccountId='owner-v206';
  const leaseExpiresAtMs=Date.now()+60_000;
  for(const bad of [
    {deviceId,ownerAccountId,authorizationEpoch:'1',leaseExpiresAtMs},
    {deviceId,ownerAccountId,authorizationEpoch:1,leaseExpiresAtMs:Date.now()-1},
    {deviceId,ownerAccountId,authorizationEpoch:1,leaseExpiresAtMs:Date.now()+301_000},
    {deviceId,ownerAccountId,authorizationEpoch:1},
    {deviceId,ownerAccountId,ownerId:'another-owner',authorizationEpoch:1,leaseExpiresAtMs},
  ]){
    response=bad;
    assert.equal(await verify('Bearer nwx_dev_credential-1234567890'),undefined);
  }
});
