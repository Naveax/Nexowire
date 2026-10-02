import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createControlPlaneAgentCredentialVerifier,
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
