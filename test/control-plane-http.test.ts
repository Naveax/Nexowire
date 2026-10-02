import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import {
  ControlPlaneService,
  type ControlPlaneIdentity,
} from '../src/product/control-plane-service.js';
import { createControlPlaneHttpHandler } from '../src/product/control-plane-http.js';

async function setup() {
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store, {
    now: () => new Date('2026-10-02T12:00:00.000Z'),
  });
  await service.ensureAccount({
    id: 'acct-1',
    displayName: 'Naveax',
  });
  await service.ensureAccount({
    id: 'owner',
    admin: true,
  });

  const handler = createControlPlaneHttpHandler(service, {
    authenticate: async (request) => {
      const raw = request.headers.get('x-test-identity');
      if (!raw) return null;
      return JSON.parse(raw) as ControlPlaneIdentity;
    },
  });

  return { service, handler };
}

function request(
  path: string,
  identity?: ControlPlaneIdentity,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (identity) {
    headers.set('x-test-identity', JSON.stringify(identity));
  }
  return new Request('https://control.test' + path, {
    ...init,
    headers,
  });
}

test('dashboard endpoint requires authenticated identity', async () => {
  const { handler } = await setup();

  const denied = await handler(request('/api/v1/me/dashboard'));
  assert.equal(denied.status, 401);

  const allowed = await handler(
    request('/api/v1/me/dashboard', {
      accountId: 'acct-1',
      role: 'user',
    }),
  );
  assert.equal(allowed.status, 200);
  const body = await allowed.json() as { planId: string };
  assert.equal(body.planId, 'free');
});

test('admin endpoint rejects a normal user', async () => {
  const { handler } = await setup();
  const response = await handler(
    request('/api/v1/admin/overview', {
      accountId: 'acct-1',
      role: 'user',
    }),
  );
  assert.equal(response.status, 403);
});

test('pairing start plus public token consume returns one device credential', async () => {
  const { handler } = await setup();

  const start = await handler(
    request(
      '/api/v1/pairing',
      { accountId: 'acct-1', role: 'user' },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceName: 'gaming-pc' }),
      },
    ),
  );
  assert.equal(start.status, 201);
  const challenge = await start.json() as {
    pairingId: string;
    token: string;
  };

  const consume = await handler(
    request('/api/v1/pairing/consume', undefined, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairingId: challenge.pairingId,
        token: challenge.token,
        platform: 'win32',
      }),
    }),
  );
  assert.equal(consume.status, 200);
  const body = await consume.json() as {
    deviceCredential: string;
  };
  assert.match(body.deviceCredential, /^nwx_dev_/);
});

test('internal usage endpoint is service-only', async () => {
  const { handler } = await setup();
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId: 'acct-1',
      eventId: 'evt-1',
      toolName: 'machine_health',
    }),
  };

  const denied = await handler(
    request(
      '/api/v1/internal/usage/charge',
      { accountId: 'acct-1', role: 'user' },
      init,
    ),
  );
  assert.equal(denied.status, 403);

  const allowed = await handler(
    request(
      '/api/v1/internal/usage/charge',
      { accountId: 'svc', role: 'service' },
      init,
    ),
  );
  assert.equal(allowed.status, 200);
  const body = await allowed.json() as { status: string };
  assert.equal(body.status, 'charged');
});
