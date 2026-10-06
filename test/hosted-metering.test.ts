import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enforceHostedMcpMetering,
  hostedMcpUsageEventId,
} from '../src/mcp/hosted-metering.js';
import type { ControlPlaneMcpClient } from '../src/hub/control-plane-mcp-auth.js';

const authorization = {
  kind: 'control-plane' as const,
  scope: 'mcp' as const,
  accountId: 'acct-1',
  role: 'user' as const,
  allowedDeviceIds: ['device-a'],
};

function toolCall(
  id: number,
  name: string,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: {},
    },
  };
}

test('hosted metering event id is deterministic for retries and opaque', () => {
  const body = toolCall(7, 'machine_health');
  const first = hostedMcpUsageEventId({
    accountId: 'acct-1',
    body,
    toolName: 'machine_health',
    invocationId: 'fixed-invocation-0007',
  });
  const second = hostedMcpUsageEventId({
    accountId: 'acct-1',
    body,
    toolName: 'machine_health',
    invocationId: 'fixed-invocation-0007',
  });

  assert.equal(first, second);
  assert.match(first, /^mcp-[a-f0-9]{64}$/);
  assert.equal(first.includes('secret-token'), false);
});

test('local and self-hosted authorization bypass hosted billing', async () => {
  let calls = 0;
  const client = {
    chargeTool: async () => {
      calls++;
      return undefined;
    },
  } as unknown as ControlPlaneMcpClient;

  assert.deepEqual(
    await enforceHostedMcpMetering({
      authorization: {
        kind: 'static',
        scope: 'mcp',
      },
      authorizationHeader: 'Bearer local',
      body: toolCall(1, 'machine_health'),
      client,
    }),
    { allowed: true },
  );
  assert.equal(calls, 0);
});

test('hosted tool call is charged once and duplicate replay is blocked before execution', async () => {
  const seen: Array<{
    accountId: string;
    eventId: string;
    toolName: string;
  }> = [];
  let invocation = 0;
  const client = {
    chargeTool: async (input: {
      accountId: string;
      eventId: string;
      toolName: string;
    }) => {
      seen.push(input);
      invocation++;
      return {
        status:
          invocation === 1
            ? 'charged'
            : 'duplicate',
        chargedCredits:
          invocation === 1 ? 1 : 0,
        remainingCredits: 999,
        reason: null,
      };
    },
  } as unknown as ControlPlaneMcpClient;
  const body = toolCall(2, 'machine_health');
  (body.params as Record<string, unknown>)._meta = {
    'nexowire/invocation-id': 'stable-retry-0002',
  };

  assert.deepEqual(
    await enforceHostedMcpMetering({
      authorization,
      authorizationHeader:
        'Bearer nwx_mcp_retry-token',
      body,
      client,
    }),
    { allowed: true },
  );
  assert.deepEqual(
    await enforceHostedMcpMetering({
      authorization,
      authorizationHeader:
        'Bearer nwx_mcp_retry-token',
      body,
      client,
    }),
    {
      allowed: false,
      status: 409,
      error: 'duplicate_request',
      code: 'MCP_DUPLICATE_REQUEST',
      remainingCredits: 999,
    },
  );
  assert.equal(seen.length, 2);
  assert.equal(
    seen[0]?.eventId,
    seen[1]?.eventId,
  );
});

test('Free premium feature denial happens before tool execution', async () => {
  const client = {
    chargeTool: async () => ({
      status: 'denied',
      chargedCredits: 0,
      remainingCredits: 1_000,
      reason: 'feature-not-in-plan',
    }),
  } as unknown as ControlPlaneMcpClient;

  assert.deepEqual(
    await enforceHostedMcpMetering({
      authorization,
      authorizationHeader:
        'Bearer nwx_mcp_free-token',
      body: toolCall(
        3,
        'windows_private_desktop_start',
      ),
      client,
    }),
    {
      allowed: false,
      status: 403,
      error: 'forbidden',
      code: 'MCP_FEATURE_NOT_IN_PLAN',
      remainingCredits: 1_000,
    },
  );
});

test('quota exhaustion and control-plane outage fail closed', async () => {
  const quotaClient = {
    chargeTool: async () => ({
      status: 'denied',
      chargedCredits: 0,
      remainingCredits: 0,
      reason: 'quota-exhausted',
    }),
  } as unknown as ControlPlaneMcpClient;

  assert.deepEqual(
    await enforceHostedMcpMetering({
      authorization,
      authorizationHeader:
        'Bearer nwx_mcp_quota-token',
      body: toolCall(4, 'machine_health'),
      client: quotaClient,
    }),
    {
      allowed: false,
      status: 429,
      error: 'quota_exhausted',
      code: 'MCP_QUOTA_EXHAUSTED',
      remainingCredits: 0,
    },
  );

  const offlineClient = {
    chargeTool: async () => undefined,
  } as unknown as ControlPlaneMcpClient;
  assert.deepEqual(
    await enforceHostedMcpMetering({
      authorization,
      authorizationHeader:
        'Bearer nwx_mcp_offline-token',
      body: toolCall(5, 'machine_health'),
      client: offlineClient,
    }),
    {
      allowed: false,
      status: 503,
      error: 'service_unavailable',
      code: 'MCP_METERING_UNAVAILABLE',
    },
  );
});

test('multi-tool batches are rejected before any charge to avoid partial billing', async () => {
  let calls = 0;
  const client = {
    chargeTool: async () => {
      calls++;
      return {
        status: 'charged',
        chargedCredits: 1,
        remainingCredits: 10,
        reason: null,
      };
    },
  } as unknown as ControlPlaneMcpClient;

  assert.deepEqual(
    await enforceHostedMcpMetering({
      authorization,
      authorizationHeader:
        'Bearer nwx_mcp_batch-token',
      body: [
        toolCall(6, 'machine_health'),
        toolCall(7, 'devices_list'),
      ],
      client,
    }),
    {
      allowed: false,
      status: 400,
      error: 'invalid_request',
      code: 'MCP_METERED_BATCH_UNSUPPORTED',
    },
  );
  assert.equal(calls, 0);
});

test('distinct invocation ids charge separately while repeated ids are rejected', async () => {
  const seen = new Set<string>();
  const client = {
    chargeTool: async (input: { eventId: string }) => {
      const duplicate = seen.has(input.eventId);
      if (!duplicate) seen.add(input.eventId);
      return {
        status: duplicate ? 'duplicate' : 'charged',
        chargedCredits: duplicate ? 0 : 1,
        remainingCredits: 1000 - seen.size,
        reason: null,
      };
    },
  } as unknown as ControlPlaneMcpClient;
  const meter = async (body: Record<string, unknown>) => enforceHostedMcpMetering({
    authorization, authorizationHeader: 'Bearer nwx_mcp_token', body, client,
  });
  const first = toolCall(41, 'machine_health');
  const second = toolCall(42, 'machine_health');
  (first.params as Record<string, unknown>)._meta = { 'nexowire/invocation-id': 'first-invocation-0041' };
  (second.params as Record<string, unknown>)._meta = { 'nexowire/invocation-id': 'second-invocation-0042' };
  assert.deepEqual(await meter(first), { allowed: true });
  assert.deepEqual(await meter(second), { allowed: true });
  const replay = await meter(first);
  assert.equal(replay.allowed, false);
  assert.equal(replay.status, 409);
  assert.equal(replay.code, 'MCP_DUPLICATE_REQUEST');
  assert.equal(seen.size, 2);
});

test('reused JSON-RPC id in a new HTTP invocation is metered again', async () => {
  const ids: string[] = [];
  const client = {
    chargeTool: async (request: { eventId: string }) => {
      ids.push(request.eventId);
      return { status: 'charged', chargedCredits: 1, remainingCredits: 1000 - ids.length, reason: null };
    },
  } as unknown as ControlPlaneMcpClient;
  const body = toolCall(42, 'machine_health');
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(await enforceHostedMcpMetering({
      authorization, authorizationHeader: 'Bearer nwx_mcp_test', body, client,
    }), { allowed: true });
  }
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test('invalid caller invocation id is refused before charging', async () => {
  let calls = 0;
  const client = { chargeTool: async () => { calls++; return undefined; } } as unknown as ControlPlaneMcpClient;
  const body = toolCall(43, 'machine_health');
  (body.params as Record<string, unknown>)._meta = { 'nexowire/invocation-id': '!' };
  assert.deepEqual(await enforceHostedMcpMetering({
    authorization, authorizationHeader: 'Bearer nwx_mcp_test', body, client,
  }), { allowed: false, status: 400, error: 'invalid_request', code: 'MCP_INVALID_INVOCATION_ID' });
  assert.equal(calls, 0);
});
