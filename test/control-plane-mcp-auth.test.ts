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
