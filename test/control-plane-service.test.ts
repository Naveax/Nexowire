import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryControlPlaneStore } from '../src/product/memory-control-plane-store.js';
import {
  ControlPlaneService,
  verifyDeviceCredential,
} from '../src/product/control-plane-service.js';

const fixedNow = new Date('2026-10-02T12:00:00.000Z');

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
  assert.equal(dashboard.usage.monthlyCredits, 20_000);
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
    }),
    /PAIRING_ALREADY-CONSUMED/,
  );
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
