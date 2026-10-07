import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import {
  ControlPlaneService,
  verifyDeviceCredential,
} from '../src/product/control-plane-service.js';

const fixedNow = new Date('2026-10-02T12:00:00.000Z');
const anchorA = 'a'.repeat(64);
const anchorB = 'b'.repeat(64);
const anchorShared = 'c'.repeat(64);

function setup() {
  const store = new MemoryControlPlaneStore();
  const service = new ControlPlaneService(store, {
    now: () => fixedNow,
    infrastructure: () => ({
      freeCapacityPercent: 42,
      prepaidCapacityCredits: 0,
    }),
  });
  return { store, service };
}

test('new accounts default to free plan and dashboard is empty', async () => {
  const { service } = setup();
  await service.ensureAccount({
    id: 'acct-1',
    displayName: 'Naveax',
  });

  const dashboard = await service.dashboard({
    accountId: 'acct-1',
    role: 'user',
  });

  assert.equal(dashboard.planId, 'free');
  assert.equal(dashboard.usage.monthlyCredits, 1_000);
  assert.equal(dashboard.devices.length, 0);
  assert.equal(dashboard.privateControlsIncluded, false);
});

test('pairing creates one device credential and stores only its hash', async () => {
  const { store, service } = setup();
  await service.ensureAccount({ id: 'acct-1' });

  const pairing = await service.beginPairing(
    { accountId: 'acct-1', role: 'user' },
    'gaming-pc',
  );
  const consumed = await service.consumePairing({
    pairingId: pairing.pairingId,
    token: pairing.token,
    platform: 'win32',
    deviceAnchorHash: anchorA,
  });

  assert.match(consumed.deviceCredential, /^nwx_dev_/);
  assert.equal(
    consumed.device.credentialHash.includes(
      consumed.deviceCredential,
    ),
    false,
  );
  assert.equal(
    verifyDeviceCredential(
      consumed.device,
      consumed.deviceCredential,
    ),
    true,
  );

  const persisted = await store.getDevice(consumed.device.id);
  assert.ok(persisted);
  assert.equal(
    persisted?.credentialHash,
    consumed.device.credentialHash,
  );

  await assert.rejects(
    service.consumePairing({
      pairingId: pairing.pairingId,
      token: pairing.token,
      platform: 'win32',
      deviceAnchorHash: anchorA,
    }),
    /PAIRING_ALREADY-CONSUMED/,
  );
});

test('paired devices default SAFE and only their owner can persist Full Access', async () => {
  const { service } = setup();
  await service.ensureAccount({ id: 'acct-access-owner' });
  await service.ensureAccount({ id: 'acct-access-other' });

  const pairing = await service.beginPairing(
    { accountId: 'acct-access-owner', role: 'user' },
    'access-pc',
  );
  const consumed = await service.consumePairing({
    pairingId: pairing.pairingId,
    token: pairing.token,
    platform: 'win32',
    deviceAnchorHash: 'f'.repeat(64),
  });
  assert.equal(consumed.device.accessMode, 'safe');

  const initial = await service.dashboard({
    accountId: 'acct-access-owner',
    role: 'user',
  });
  assert.equal(initial.devices[0]?.accessMode, 'safe');

  const enabled = await service.setDeviceAccessMode(
    { accountId: 'acct-access-owner', role: 'user' },
    consumed.device.id,
    'full',
  );
  assert.equal(enabled.accessMode, 'full');

  const persisted = await service.dashboard({
    accountId: 'acct-access-owner',
    role: 'user',
  });
  assert.equal(persisted.devices[0]?.accessMode, 'full');

  await assert.rejects(
    service.setDeviceAccessMode(
      { accountId: 'acct-access-other', role: 'user' },
      consumed.device.id,
      'full',
    ),
    /DEVICE_NOT_FOUND/,
  );

  const safe = await service.setDeviceAccessMode(
    { accountId: 'acct-access-owner', role: 'user' },
    consumed.device.id,
    'safe',
  );
  assert.equal(safe.accessMode, 'safe');
});

test('free device limit is enforced before issuing another credential', async () => {
  const { service } = setup();
  await service.ensureAccount({ id: 'acct-1' });

  for (const name of ['pc-1', 'pc-2']) {
    const pairing = await service.beginPairing(
      { accountId: 'acct-1', role: 'user' },
      name,
    );
    await service.consumePairing({
      pairingId: pairing.pairingId,
      token: pairing.token,
      platform: 'win32',
      deviceAnchorHash:
        name === 'pc-1' ? anchorA : anchorB,
    });
  }

  await assert.rejects(
    service.beginPairing(
      { accountId: 'acct-1', role: 'user' },
      'pc-3',
    ),
    /DEVICE_LIMIT_REACHED/,
  );
});

test('re-pairing an existing device works even when the device limit is full', async () => {
  const { store, service } = setup();
  await service.ensureAccount({ id: 'acct-1' });

  const firstDeviceId =
    '11111111-1111-4111-8111-111111111111';
  const secondDeviceId =
    '22222222-2222-4222-8222-222222222222';

  for (const [name, deviceId, anchor] of [
    ['pc-1', firstDeviceId, anchorA],
    ['pc-2', secondDeviceId, anchorB],
  ] as const) {
    const pairing = await service.beginPairing(
      { accountId: 'acct-1', role: 'user' },
      name,
      deviceId,
    );
    await service.consumePairing({
      pairingId: pairing.pairingId,
      token: pairing.token,
      platform: 'win32',
      deviceAnchorHash: anchor,
    });
  }

  const before = await store.getDevice(firstDeviceId);
  assert.ok(before);

  const pairing = await service.beginPairing(
    { accountId: 'acct-1', role: 'user' },
    'pc-1',
    firstDeviceId,
  );
  const repaired = await service.consumePairing({
    pairingId: pairing.pairingId,
    token: pairing.token,
    platform: 'win32',
    deviceAnchorHash: anchorA,
  });

  assert.equal(repaired.device.id, firstDeviceId);
  assert.equal(repaired.device.ownerAccountId, 'acct-1');
  assert.notEqual(
    repaired.device.credentialHash,
    before?.credentialHash,
  );
});

test('usage charging is idempotent and updates dashboard credits', async () => {
  const { service } = setup();
  await service.ensureAccount({ id: 'acct-1' });

  const first = await service.chargeUsage({
    accountId: 'acct-1',
    eventId: 'event-1',
    toolName: 'machine_health',
  });
  const duplicate = await service.chargeUsage({
    accountId: 'acct-1',
    eventId: 'event-1',
    toolName: 'machine_health',
  });

  assert.equal(first.status, 'charged');
  assert.equal(first.chargedCredits, 1);
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.chargedCredits, 0);

  const dashboard = await service.dashboard({
    accountId: 'acct-1',
    role: 'user',
  });
  assert.equal(dashboard.usage.usedCredits, 1);
});

test('same device anchor merges free quota across different accounts', async () => {
  const { store, service } = setup();
  const accountA = await service.ensureAccount({ id: 'acct-a' });
  const accountB = await service.ensureAccount({ id: 'acct-b' });

  const usedByA = await service.chargeUsage({
    accountId: accountA.id,
    eventId: 'a-before-link',
    toolName: 'machine_health',
    baseCredits: 400,
  });
  const usedByB = await service.chargeUsage({
    accountId: accountB.id,
    eventId: 'b-before-link',
    toolName: 'machine_health',
    baseCredits: 200,
  });
  assert.equal(usedByA.status, 'charged');
  assert.equal(usedByB.status, 'charged');

  const pairingA = await service.beginPairing(
    { accountId: accountA.id, role: 'user' },
    'shared-pc-a',
  );
  await service.consumePairing({
    pairingId: pairingA.pairingId,
    token: pairingA.token,
    platform: 'win32',
    deviceAnchorHash: anchorShared,
  });

  const pairingB = await service.beginPairing(
    { accountId: accountB.id, role: 'user' },
    'shared-pc-b',
  );
  await service.consumePairing({
    pairingId: pairingB.pairingId,
    token: pairingB.token,
    platform: 'win32',
    deviceAnchorHash: anchorShared,
  });

  const persistedA = await store.getAccount(accountA.id);
  const persistedB = await store.getAccount(accountB.id);
  assert.ok(persistedA);
  assert.ok(persistedB);
  assert.equal(
    persistedA?.quotaSubjectId,
    persistedB?.quotaSubjectId,
  );

  const dashboardA = await service.dashboard({
    accountId: accountA.id,
    role: 'user',
  });
  const dashboardB = await service.dashboard({
    accountId: accountB.id,
    role: 'user',
  });
  assert.equal(dashboardA.usage.usedCredits, 600);
  assert.equal(dashboardB.usage.usedCredits, 600);

  const overQuota = await service.chargeUsage({
    accountId: accountB.id,
    eventId: 'b-after-link',
    toolName: 'machine_health',
    baseCredits: 401,
  });
  assert.equal(overQuota.status, 'denied');
  assert.equal(overQuota.reason, 'quota-exhausted');
  assert.equal(overQuota.remainingCredits, 400);
});

test('admin overview requires both admin identity and admin account flag', async () => {
  const { service } = setup();
  await service.ensureAccount({ id: 'owner', admin: true });
  await service.ensureAccount({ id: 'user' });

  const overview = await service.adminOverview({
    accountId: 'owner',
    role: 'admin',
  });
  assert.equal(overview.users.total, 2);
  assert.equal(
    overview.infrastructure.ownerPaidSpendAllowed,
    false,
  );
  assert.equal(
    overview.infrastructure.freeCapacityPercent,
    42,
  );

  await assert.rejects(
    service.adminOverview({
      accountId: 'user',
      role: 'admin',
    }),
    /ADMIN_REQUIRED/,
  );
});


test('device presence updates dashboard and ignores stale state events', async () => {
  const { service } = setup();
  await service.ensureAccount({ id: 'acct-1' });

  const pairing = await service.beginPairing(
    { accountId: 'acct-1', role: 'user' },
    'work-pc',
    '11111111-1111-4111-8111-111111111111',
  );
  const consumed = await service.consumePairing({
    pairingId: pairing.pairingId,
    token: pairing.token,
    platform: 'win32',
    deviceAnchorHash: anchorA,
  });

  assert.equal(
    await service.setDevicePresence(
      consumed.device.id,
      true,
      '2026-10-04T13:36:15.338Z',
      {
        agentVersion: '1.0.4',
        privilegeMode: 'broker',
        adminBridgeReady: true,
      },
    ),
    true,
  );

  let dashboard = await service.dashboard({
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

  assert.equal(
    await service.setDevicePresence(
      consumed.device.id,
      false,
      '2026-10-04T13:36:14.000Z',
    ),
    true,
  );
  dashboard = await service.dashboard({
    accountId: 'acct-1',
    role: 'user',
  });
  assert.equal(dashboard.devices[0]?.online, true);
  assert.equal(dashboard.devices[0]?.agentVersion, '1.0.4');
  assert.equal(dashboard.devices[0]?.privilegeMode, 'broker');
  assert.equal(dashboard.devices[0]?.adminBridgeReady, true);

  assert.equal(
    await service.setDevicePresence(
      consumed.device.id,
      false,
      '2026-10-04T13:36:16.338Z',
    ),
    true,
  );
  dashboard = await service.dashboard({
    accountId: 'acct-1',
    role: 'user',
  });
  assert.equal(dashboard.devices[0]?.online, false);
  assert.equal(
    dashboard.devices[0]?.lastSeenAt,
    '2026-10-04T13:36:16.338Z',
  );
  assert.equal(dashboard.devices[0]?.agentVersion, '1.0.4');
  assert.equal(dashboard.devices[0]?.privilegeMode, 'broker');
  assert.equal(dashboard.devices[0]?.adminBridgeReady, true);
});
