import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PathPolicy, PathDeniedError } from '../src/agent/path-policy.js';
import {
  ScopedPathGrantRegistry,
  mapVolumeGrantRoot,
  isRemovableVolume,
  sameVolume,
  unsafeWindowsPath,
  type VolumeIdentity,
} from '../src/agent/scoped-path-grants.js';

const USB: VolumeIdentity = {
  driveLetter: 'E',
  volumeId: '\\\\?\\Volume{source-disk}\\',
  deviceId: 'USB-SERIAL-001',
  busType: 'USB',
  driveType: 'Removable',
  partitionNumber: 1,
};

async function fixture(t: import('node:test').TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-scoped-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const allowed = path.join(dir, 'user-a');
  const denied = path.join(dir, 'user-b');
  await fs.mkdir(allowed);
  await fs.mkdir(denied);
  await fs.writeFile(path.join(allowed, 'ok.txt'), 'ok');
  await fs.writeFile(path.join(denied, 'private.txt'), 'secret');
  return { dir, allowed, denied };
}

test('read/write/delete/move/recursive-delete are distinct scopes', async t => {
  const { allowed } = await fixture(t);
  const p = new PathPolicy([allowed], { defaultScopes: ['read'] });
  const file = path.join(allowed, 'ok.txt');
  assert.equal(await p.authorizeExisting(file, 'read'), await fs.realpath(file));
  for (const scope of ['write', 'delete', 'move', 'recursive_delete'] as const) {
    await assert.rejects(() => p.authorizeExisting(file, scope),
      (error: unknown) => error instanceof PathDeniedError &&
        error.code === 'PATH_DENIED' && error.details.scope === scope);
  }
});

test('target-bound owner/device grants expire and can be revoked', async t => {
  const { allowed, denied } = await fixture(t);
  let clock = 1000;
  const store = new ScopedPathGrantRegistry(() => clock);
  store.grantLocally({
    id: 'grant-001', ownerId: 'owner-A', deviceId: 'device-A',
    root: allowed, scopes: ['write', 'move'], expiresAt: 4000,
  });
  const p = new PathPolicy([allowed], {
    defaultScopes: ['read'], grants: store, ownerId: 'owner-A',
    deviceId: 'device-A', now: () => clock,
  });
  assert.equal(await p.authorizeForCreate(path.join(allowed, 'new.txt'), 'write'),
    path.join(await fs.realpath(allowed), 'new.txt'));
  await assert.rejects(() => p.authorizeExisting(path.join(denied, 'private.txt'), 'write'),
    PathDeniedError);
  await assert.rejects(() => p.authorizeExisting(path.join(allowed, 'ok.txt'), 'delete'),
    PathDeniedError);
  const wrongOwner = new PathPolicy([allowed], {
    defaultScopes: ['read'], grants: store, ownerId: 'owner-B', deviceId: 'device-A',
  });
  await assert.rejects(() => wrongOwner.authorizeExisting(path.join(allowed, 'ok.txt'), 'write'),
    PathDeniedError);
  const wrongDevice = new PathPolicy([allowed], {
    defaultScopes: ['read'], grants: store, ownerId: 'owner-A', deviceId: 'device-B',
  });
  await assert.rejects(() => wrongDevice.authorizeExisting(path.join(allowed, 'ok.txt'), 'write'),
    PathDeniedError);
  clock = 4000;
  await assert.rejects(() => p.authorizeExisting(path.join(allowed, 'ok.txt'), 'write'),
    PathDeniedError);
  clock = 1000;
  assert.equal(store.revoke('grant-001'), true);
  await assert.rejects(() => p.authorizeExisting(path.join(allowed, 'ok.txt'), 'write'),
    PathDeniedError);
});

test('USB writes require a separate exact-volume grant, including when root allows write', async t => {
  const { allowed } = await fixture(t);
  let observed: VolumeIdentity = USB;
  const registry = new ScopedPathGrantRegistry();
  const p = new PathPolicy([allowed], {
    defaultScopes: ['read','write','move','delete','recursive_delete'],
    grants: registry, ownerId: 'owner-A', deviceId: 'device-A',
    platform: 'win32', volumeResolver: async () => observed,
  });
  const destination = path.join(allowed, 'test.txt');
  await assert.rejects(() => p.authorizeForCreate(destination, 'write'),
    (error: unknown) => error instanceof PathDeniedError &&
      error.details.reason === 'USB_VOLUME_GRANT_REQUIRED');
  registry.grantLocally({
    id: 'usb-grant-001', ownerId: 'owner-A', deviceId: 'device-A',
    root: allowed, scopes: ['usb_write'], expiresAt: Date.now() + 60_000,
    volume: { volumeId: USB.volumeId, deviceId: USB.deviceId, partitionNumber: 1 },
  });
  assert.equal(await p.authorizeForCreate(destination, 'write'),
    path.join(await fs.realpath(allowed), 'test.txt'));
  observed = { ...USB, volumeId: '\\\\?\\Volume{replaced-disk}\\' };
  await assert.rejects(() => p.authorizeForCreate(destination, 'write'),
    PathDeniedError);
  observed = { ...USB, deviceId: 'USB-SERIAL-OTHER' };
  await assert.rejects(() => p.authorizeForCreate(destination, 'write'),
    PathDeniedError);
  observed = { ...USB, partitionNumber: 2 };
  await assert.rejects(() => p.authorizeForCreate(destination, 'write'),
    PathDeniedError);
  observed = USB;
  assert.equal(registry.revoke('usb-grant-001'), true);
  await assert.rejects(() => p.authorizeForCreate(destination, 'write'),
    PathDeniedError);
});

test('unverifiable identity fails closed rather than allowing wrong USB/partition', async t => {
  const { allowed } = await fixture(t);
  const p = new PathPolicy([allowed], {
    platform: 'win32', volumeResolver: async () => { throw new Error('disk unplugged'); },
  });
  await assert.rejects(() => p.authorizeForCreate(path.join(allowed, 'test.txt'), 'write'),
    (error: unknown) => error instanceof PathDeniedError &&
      error.details.reason === 'VOLUME_IDENTITY_UNAVAILABLE');
});

test('raw disk, device namespace, UNC, WSL share and drive-relative paths are denied', () => {
  for (const unsafe of [
    '\\\\.\\PhysicalDrive0',
    '\\\\?\\GLOBALROOT\\Device\\Harddisk0\\Partition1',
    '\\\\?\\Volume{123}\\',
    '\\\\wsl$\\Ubuntu\\mnt\\c\\secrets',
    '\\\\server\\share\\file.txt',
    'E:relative.txt',
    'E:\\safe\\file.txt:payload',
    'C:\\Users\\Alice\\NUL.txt',
  ]) {
    assert.ok(unsafeWindowsPath(unsafe), unsafe);
  }
  assert.equal(unsafeWindowsPath('E:\\safe\\file.txt'), null);
});

test('scoped shell execution cannot bypass file policy by selecting another cwd', async t => {
  const { allowed } = await fixture(t);
  const restricted = new PathPolicy([allowed]);
  assert.throws(() => restricted.assertUnrestrictedExecution(),
    (error: unknown) => error instanceof PathDeniedError &&
      error.details.reason === 'UNSANDBOXED_EXECUTION_DENIED');
  const wildcard = new PathPolicy(['*']);
  assert.doesNotThrow(() => wildcard.assertUnrestrictedExecution());
});

test('path root cannot be implicitly deleted or formatted', async () => {
  const p = new PathPolicy(['*']);
  await assert.rejects(() => p.authorizeExisting(path.parse(os.tmpdir()).root, 'recursive_delete'),
    (error: unknown) => error instanceof PathDeniedError &&
      error.details.reason === 'VOLUME_ROOT_MUTATION_DENIED');
});

test('stable identifiers must all match, regardless of changing drive letter', () => {
  assert.ok(isRemovableVolume(USB));
  assert.equal(sameVolume(USB, { ...USB, driveLetter: 'F' }), true);
  assert.equal(sameVolume(USB, { ...USB, partitionNumber: 7 }), false);
});

test('USB grant follows reassigned letter only when stable volume identity matches', () => {
  if (process.platform !== 'win32') return;
  const store = new ScopedPathGrantRegistry();
  const grant = {
    id: 'usb-follow-letter-001', ownerId: 'owner', deviceId: 'device',
    root: 'E:\\Work\\Debian', scopes: ['usb_write'] as const,
    expiresAt: Date.now() + 60_000,
    volume: { volumeId: USB.volumeId, deviceId: USB.deviceId, partitionNumber: 1 },
  };
  store.grantLocally(grant);
  assert.equal(mapVolumeGrantRoot(grant, 'F:\\Work\\Debian\\image.bin'),
    'F:\\Work\\Debian');
  assert.equal(store.authorizes('F:\\Work\\Debian\\image.bin',
    'usb_write', 'owner', 'device', { ...USB, driveLetter: 'F' }), true);
  assert.equal(store.authorizes('F:\\Work\\Debian\\image.bin',
    'usb_write', 'owner', 'device', {
      ...USB, driveLetter: 'F', deviceId: 'OTHER-DEVICE',
    }), false);
  assert.equal(store.authorizes('F:\\Work\\Other\\image.bin',
    'usb_write', 'owner', 'device', { ...USB, driveLetter: 'F' }), false);
});

test('grant lifetime cannot exceed one day or start expired', () => {
  const store = new ScopedPathGrantRegistry(() => 1_000);
  const baseline = {
    id: 'grant-001', ownerId: 'owner', deviceId: 'device',
    root: path.resolve(os.tmpdir()), scopes: ['read'] as const,
  };
  assert.throws(() => store.grantLocally({ ...baseline, expiresAt: 1_000 }));
  assert.throws(() => store.grantLocally({
    ...baseline, expiresAt: 1_000 + 86_400_001,
  }));
});
