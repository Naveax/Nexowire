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
    agentUrl: 'wss://relay.example.test/agent',
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
        deviceAnchorHash: 'd'.repeat(64),
      }),
    }),
  );
  assert.equal(consume.status, 200);
  const body = await consume.json() as {
    deviceCredential: string;
  };
  assert.match(body.deviceCredential, /^nwx_dev_/);
});

test('Full Access enablement requires explicit site confirmation and persists until SAFE', async () => {
  const { service, handler } = await setup();
  const pairing = await service.beginPairing(
    { accountId: 'acct-1', role: 'user' },
    'access-pc',
  );
  const consumed = await service.consumePairing({
    pairingId: pairing.pairingId,
    token: pairing.token,
    platform: 'win32',
    deviceAnchorHash: '9'.repeat(64),
  });

  const identity = { accountId: 'acct-1', role: 'user' } as const;
  const body = JSON.stringify({
    deviceId: consumed.device.id,
    mode: 'full',
  });

  const missingConfirmation = await handler(
    request('/api/v1/me/devices/access-mode', identity, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );
  assert.equal(missingConfirmation.status, 400);
  assert.deepEqual(
    await missingConfirmation.json(),
    { error: 'FULL_ACCESS_CONFIRMATION_REQUIRED' },
  );

  const enabled = await handler(
    request('/api/v1/me/devices/access-mode', identity, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nexowire-confirm': 'full-access-v1',
      },
      body,
    }),
  );
  assert.equal(enabled.status, 200);
  assert.equal(
    (await enabled.json() as { accessMode: string }).accessMode,
    'full',
  );

  const dashboard = await handler(
    request('/api/v1/me/dashboard', identity),
  );
  const snapshot = await dashboard.json() as {
    devices: Array<{ accessMode: string }>;
  };
  assert.equal(snapshot.devices[0]?.accessMode, 'full');

  const disabled = await handler(
    request('/api/v1/me/devices/access-mode', identity, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: consumed.device.id,
        mode: 'safe',
      }),
    }),
  );
  assert.equal(disabled.status, 200);
  assert.equal(
    (await disabled.json() as { accessMode: string }).accessMode,
    'safe',
  );
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


test('device presence endpoint is service-only and updates dashboard state', async () => {
  const { service, handler } = await setup();
  const pairing = await service.beginPairing(
    { accountId: 'acct-1', role: 'user' },
    'work-pc',
    '11111111-1111-4111-8111-111111111111',
  );
  const consumed = await service.consumePairing({
    pairingId: pairing.pairingId,
    token: pairing.token,
    platform: 'win32',
    deviceAnchorHash: 'e'.repeat(64),
  });
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: consumed.device.id,
      online: true,
      at: '2026-10-04T13:36:15.338Z',
      agentVersion: '1.0.4',
      privilegeMode: 'broker',
      adminBridgeReady: true,
    }),
  };

  const denied = await handler(
    request(
      '/api/v1/internal/device/presence',
      { accountId: 'acct-1', role: 'user' },
      init,
    ),
  );
  assert.equal(denied.status, 403);

  const allowed = await handler(
    request(
      '/api/v1/internal/device/presence',
      { accountId: 'svc', role: 'service' },
      init,
    ),
  );
  assert.equal(allowed.status, 200);

  const dashboard = await service.dashboard({
    accountId: 'acct-1',
    role: 'user',
  });
  assert.equal(dashboard.devices[0]?.online, true);
  assert.equal(
    dashboard.devices[0]?.lastSeenAt,
    '2026-10-04T13:36:15.338Z',
  );
  assert.equal(dashboard.devices[0]?.agentVersion, '1.0.4');
  assert.equal(dashboard.devices[0]?.privilegeMode, 'broker');
  assert.equal(dashboard.devices[0]?.adminBridgeReady, true);

  const invalid = await handler(
    request(
      '/api/v1/internal/device/presence',
      { accountId: 'svc', role: 'service' },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: consumed.device.id,
          online: true,
          at: '2026-10-04T13:36:16.338Z',
          privilegeMode: 'anything-goes',
        }),
      },
    ),
  );
  assert.equal(invalid.status, 400);
});

test('public usage policy reports server-side Free limits without exposing account data', async () => {
  const { handler } = await setup();
  const response = await handler(request('/api/v1/public/usage-policy'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json() as Record<string, unknown>;
  assert.deepEqual(result, {
    planId: 'free',
    monthlyCredits: 1_000,
    normalToolCredits: 1,
    specialSkillToolCredits: 5,
    quotaPeriod: 'calendar-month-utc',
  });
  assert.equal('accountId' in result, false);
  assert.equal('usedCredits' in result, false);
});

test('public policy supports read only; authenticated account data remains protected', async () => {
  const { handler } = await setup();
  const rejected = await handler(request('/api/v1/public/usage-policy', undefined, { method: 'POST' }));
  assert.equal(rejected.status, 401);
  const privateDashboard = await handler(request('/api/v1/me/dashboard'));
  assert.equal(privateDashboard.status, 401);
});

test('ROOT site activation denies missing confirmation and unsafe devices', async () => {
  const { service, handler } = await setup();
  const owner = { accountId: 'acct-1', role: 'user' } as const;
  const challenge = await service.beginPairing(owner, 'root-http-test');
  const paired = await service.consumePairing({
    pairingId: challenge.pairingId, token: challenge.token,
    platform: 'win32', deviceAnchorHash: '4'.repeat(64),
  });
  const id = paired.device.id;
  const route = '/api/v1/me/devices/root-mode';
  const enable = JSON.stringify({
    deviceId: id, enabled: true, confirmation: 'ROOT DANGER',
  });
  const unauthenticated = await handler(request(route, undefined, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: enable,
  }));
  assert.equal(unauthenticated.status, 401);
  const denied = await handler(request(route, owner, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: enable,
  }));
  assert.equal(denied.status, 400);
  assert.deepEqual(await denied.json(), { error: 'ROOT_DANGER_CONFIRMATION_REQUIRED' });
  const cannotElevate = await handler(request(route, owner, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-nexowire-confirm': 'root-danger-v1',
    },
    body: enable,
  }));
  assert.equal(cannotElevate.status, 409);
  assert.deepEqual(await cannotElevate.json(), { error: 'ROOT_REQUIRES_FULL_ONLINE_BROKER' });
  await service.setDeviceAccessMode(owner, id, 'full');
  await service.setDevicePresence(id, true, '2026-10-02T12:00:00.000Z', {
    privilegeMode: 'broker', adminBridgeReady: true,
  });
  const enabled = await handler(request(route, owner, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-nexowire-confirm': 'root-danger-v1',
    },
    body: enable,
  }));
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json() as { rootMode: { active: boolean } }).rootMode.active, true);
  const current = await handler(request('/api/v1/me/dashboard', owner));
  assert.equal((await current.json() as {
    devices: Array<{ rootMode: { active: boolean } }>;
  }).devices[0]?.rootMode.active, true);
  const off = await handler(request(route, owner, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: id, enabled: false }),
  }));
  assert.equal(off.status, 200);
  assert.equal((await off.json() as { rootMode: { active: boolean } }).rootMode.active, false);
});
