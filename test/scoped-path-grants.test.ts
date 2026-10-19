import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PathPolicy, PathDeniedError } from '../src/agent/path-policy.js';
import {
  ScopedPathGrantRegistry,
  type ScopedPathGrant,
  type FileScope,
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
  let steady = 10_000;
  // Both grant clocks must be under test control. Pairing a fake Date.now()
  // with a live performance.now() makes a 3 s fixture expire under CI load.
  const store = new ScopedPathGrantRegistry(() => clock, () => steady);
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
  // Expired grants are actively pruned; moving the clock backward cannot revive them.
  assert.equal(store.revoke('grant-001'), false);
  await assert.rejects(() => p.authorizeExisting(path.join(allowed, 'ok.txt'), 'write'),
    PathDeniedError);
});

test('fake wall time with advanced monotonic time denies VOLUME_GRANT_MISMATCH deterministically', async t => {
  const { allowed } = await fixture(t);
  let wall = 1_000;
  let steady = 4_000;
  const registry = new ScopedPathGrantRegistry(() => wall, () => steady);
  registry.grantLocally({
    id: 'grant-clock-divergence', ownerId: 'owner', deviceId: 'device',
    root: allowed, scopes: ['write'], expiresAt: wall + 3_000,
  });
  const policy = new PathPolicy([allowed], {
    defaultScopes: ['read'], grants: registry, ownerId: 'owner',
    deviceId: 'device', now: () => wall,
  });
  const target = path.join(allowed, 'temporary.txt');
  assert.equal(await policy.authorizeForCreate(target, 'write'),
    path.join(await fs.realpath(allowed), 'temporary.txt'));
  steady += 3_001;  // Simulated CI stall, no wall-clock advancement.
  await assert.rejects(() => policy.authorizeForCreate(target, 'write'),
    (error: unknown) => error instanceof PathDeniedError &&
      error.details.reason === 'SCOPE_NOT_GRANTED');
  assert.equal(registry.active('owner', 'device').length, 0);
  wall += 3_001;
  wall = 1_000; // Rollback cannot resurrect an expired monotonic grant.
  assert.deepEqual(registry.active('owner', 'device'), []);
});

test('monotonic expiry during Windows volume lookup returns mismatch fail-closed', async t => {
  const { allowed } = await fixture(t);
  let wall = 1000;
  let steady = 10_000;
  const grants = new ScopedPathGrantRegistry(() => wall, () => steady);
  grants.grantLocally({
    id: 'grant-volume-stall-01', ownerId: 'owner-A', deviceId: 'device-A',
    root: allowed, scopes: ['write'], expiresAt: wall + 3000,
  });
  const policy = new PathPolicy([allowed], {
    platform: 'win32', grants, ownerId: 'owner-A', deviceId: 'device-A',
    defaultScopes: ['read'], now: () => wall,
    volumeResolver: async () => {
      steady += 3001; // An async disk probe that exhausts the monotonic budget.
      return { ...USB, busType: 'NVMe', driveType: 'Fixed' };
    },
  });
  await assert.rejects(
    () => policy.authorizeForCreate(path.join(allowed, 'never-written.txt'), 'write'),
    (error: unknown) => error instanceof PathDeniedError &&
      error.details.reason === 'VOLUME_GRANT_MISMATCH',
  );
  assert.deepEqual(grants.active('owner-A', 'device-A'), []);
  await assert.rejects(() => fs.stat(path.join(allowed, 'never-written.txt')));
  // Reverting the wall clock must not resurrect the same authorization.
  wall = 100;
  await assert.rejects(() => policy.authorizeForCreate(
    path.join(allowed, 'never-written.txt'), 'write'), PathDeniedError);
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

test('verified volume grant cannot bypass revoked USB grant during slow probe', async t => {
  const { allowed } = await fixture(t);
  const registry = new ScopedPathGrantRegistry();
  registry.grantLocally({
    id:'grant-revoke-during-probe', ownerId:'owner', deviceId:'device',
    root: allowed, scopes:['usb_write'], expiresAt: Date.now()+60_000,
    volume: { volumeId:USB.volumeId, deviceId:USB.deviceId,
      partitionNumber: USB.partitionNumber },
  });
  const policy = new PathPolicy([allowed], {
    platform: 'win32', grants: registry, ownerId:'owner', deviceId:'device',
    defaultScopes:['write'], volumeResolver:async () => {
      registry.revoke('grant-revoke-during-probe');
      return {...USB};
    },
  });
  await assert.rejects(() => policy.authorizeForCreate(
    path.join(allowed,'new.bin'), 'write'),
    (err: unknown) => err instanceof PathDeniedError &&
      err.details.reason === 'USB_VOLUME_GRANT_REQUIRED');
  await assert.rejects(() => fs.stat(path.join(allowed,'new.bin')));
});

test('native Windows handle gate denies synthetic USB mutation even with valid grant', async t => {
  const { allowed } = await fixture(t);
  const grants = new ScopedPathGrantRegistry();
  grants.grantLocally({
    id:'native-handle-gate-01', ownerId:'owner', deviceId:'device',
    root:allowed, scopes:['usb_write'], expiresAt:Date.now() + 60_000,
    volume:{volumeId:USB.volumeId, deviceId:USB.deviceId,
      partitionNumber: USB.partitionNumber},
  });
  const policy = new PathPolicy([allowed], {
    platform:'win32', grants, ownerId:'owner', deviceId:'device',
    defaultScopes:['read','write'],
    enforceWindowsNativeHandleBoundary:true,
    volumeResolver:async()=>USB,
  });
  const target = path.join(allowed, 'blocked-usb.txt');
  await assert.rejects(() => policy.authorizeForCreate(target, 'write'),
    (e:unknown)=>e instanceof PathDeniedError &&
      e.details.reason==='WINDOWS_NATIVE_HANDLE_GUARD_REQUIRED');
  await assert.rejects(() => fs.stat(target));
  // Refusing the native helper is deliberate even after valid local consent.
  assert.equal(grants.active('owner','device').length,1);
});

test('native Windows handle gate denies grant-only mutation of a fixed volume', async t => {
  const { allowed } = await fixture(t);
  const grants = new ScopedPathGrantRegistry();
  grants.grantLocally({
    id:'native-handle-gate-02', ownerId:'owner', deviceId:'device',
    root:allowed, scopes:['write'], expiresAt:Date.now()+60_000,
  });
  const policy = new PathPolicy([allowed], {
    platform:'win32', grants, ownerId:'owner', deviceId:'device',
    defaultScopes:['read'], enforceWindowsNativeHandleBoundary:true,
    volumeResolver:async()=>({...USB,busType:'NVMe',driveType:'Fixed'}),
  });
  await assert.rejects(()=>policy.authorizeForCreate(
    path.join(allowed,'blocked-grant-only.txt'),'write'),
    (e:unknown)=>e instanceof PathDeniedError &&
      e.details.reason==='WINDOWS_NATIVE_HANDLE_GUARD_REQUIRED');
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
  const restricted = new PathPolicy([allowed], { enforceExecutionBoundary: true });
  assert.throws(() => restricted.assertUnrestrictedExecution(),
    (error: unknown) => error instanceof PathDeniedError &&
      error.details.reason === 'UNSANDBOXED_EXECUTION_DENIED');
  const wildcard = new PathPolicy(['*'], { enforceExecutionBoundary: true });
  assert.throws(() => wildcard.assertUnrestrictedExecution(), PathDeniedError);
  const leased = new PathPolicy(['*'], {
    enforceExecutionBoundary: true,
    unrestrictedExecutionUntil: Date.now() + 60_000,
  });
  assert.doesNotThrow(() => leased.assertUnrestrictedExecution());
  const overlong = new PathPolicy(['*'], {
    enforceExecutionBoundary: true,
    unrestrictedExecutionUntil: Date.now() + 24 * 60 * 60_000,
  });
  assert.throws(() => overlong.assertUnrestrictedExecution(), PathDeniedError);
});

test('strict Native Agent rejects shell/WSL lease even with wildcard file roots', () => {
  const policy = new PathPolicy(['*'], {
    platform:'win32', grants:new ScopedPathGrantRegistry(),
    enforceWindowsNativeHandleBoundary:true,
    unrestrictedExecutionUntil:Date.now() + 10 * 60_000,
  });
  assert.throws(() => policy.assertUnrestrictedExecution(),
    (error:unknown)=>error instanceof PathDeniedError &&
      error.details.reason==='UNSANDBOXED_EXECUTION_DENIED');
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

test('runtime-style policy with grant registry enforces shell boundary by default', () => {
  const runtime = new PathPolicy(['*'], { grants: new ScopedPathGrantRegistry() });
  assert.throws(() => runtime.assertUnrestrictedExecution(),
    (error: unknown) => error instanceof PathDeniedError &&
      error.details.reason === 'UNSANDBOXED_EXECUTION_DENIED');
  const standalone = new PathPolicy(['*']);
  assert.doesNotThrow(() => standalone.assertUnrestrictedExecution());
});

test('wildcard create resolves junction target before classifying a simulated USB volume', async t => {
  const { allowed, denied } = await fixture(t);
  const junction = path.join(allowed, 'mounted-volume');
  try {
    await fs.symlink(denied, junction, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip('Symlink/junction creation unavailable: ' + String(error));
    return;
  }
  const target = path.join(junction, 'new.txt');
  let observed = '';
  const policy = new PathPolicy(['*'], {
    platform: 'win32',
    volumeResolver: async candidate => {
      observed = candidate;
      return candidate.toLowerCase().startsWith(denied.toLowerCase())
        ? USB
        : { ...USB, busType: 'SATA', driveType: 'Fixed' };
    },
  });
  assert.equal(await policy.resolveForCreate(target),
    path.join(await fs.realpath(denied), 'new.txt'));
  await assert.rejects(() => policy.authorizeForCreate(target, 'write'),
    (error: unknown) => error instanceof PathDeniedError &&
      error.details.reason === 'USB_VOLUME_GRANT_REQUIRED');
  assert.equal(observed, path.join(await fs.realpath(denied), 'new.txt'));
});

test('grant inspection returns defensive copies, and duplicate grant IDs cannot escalate', () => {
  const wall = 10_000;
  const registry = new ScopedPathGrantRegistry(() => wall, () => 1_000);
  const scope: ScopedPathGrant = {
    id: 'grant-defensive-01', ownerId: 'owner', deviceId: 'device',
    root: path.resolve(os.tmpdir()), scopes: ['read'],
    expiresAt: 15_000,
    volume: { volumeId: USB.volumeId, deviceId: USB.deviceId, partitionNumber: 1 },
  };
  registry.grantLocally(scope);
  scope.volume!.deviceId = 'USER_MODIFIED';
  const returned = registry.active('owner','device')[0]!;
  (returned.scopes as FileScope[]).push('write','usb_write');
  returned.volume!.deviceId = 'OTHER_DEVICE';
  const again = registry.active('owner', 'device')[0]!;
  assert.deepEqual(again.scopes, ['read']);
  assert.equal(again.volume!.deviceId, USB.deviceId);
  assert.throws(() => registry.grantLocally({ ...scope, scopes: ['usb_write'] }),
    /Grant ID already exists/);
});

test('monotonic expiry does not extend after wall-clock rollback', () => {
  let wall = 10_000;
  let steady = 1_000;
  const registry = new ScopedPathGrantRegistry(() => wall, () => steady);
  registry.grantLocally({
    id:'grant-monotonic-01',ownerId:'owner',deviceId:'device',
    root:path.resolve(os.tmpdir()),scopes:['read'],expiresAt:15_000,
  });
  wall = 5_000;
  steady = 5_999;
  assert.equal(registry.active('owner','device').length, 1);
  steady = 6_000;
  assert.deepEqual(registry.active('owner','device'), []);
  wall = 12_000;
  assert.deepEqual(registry.active('owner','device'), []);
});

test('destructive grants expire within fifteen minutes and reject volume roots', () => {
  const registry = new ScopedPathGrantRegistry(() => 1000, () => 1000);
  const base = {
    id: 'usb-short-grant-01', ownerId: 'owner', deviceId: 'device',
    root: path.join(os.tmpdir(), 'safe-subdirectory'),
    scopes: ['usb_write'] as const,
    volume: { volumeId: USB.volumeId, deviceId: USB.deviceId, partitionNumber: 1 },
  };
  assert.throws(() => registry.grantLocally({
    ...base, expiresAt: 1000 + 15 * 60_000 + 1,
  }));
  assert.throws(() => registry.grantLocally({
    ...base, root: path.parse(os.tmpdir()).root,
    expiresAt: 1000 + 60_000,
  }), /entire volume root/);
  assert.throws(() => registry.grantLocally({
    ...base, root: path.parse(os.tmpdir()).root,
    scopes: ['recursive_delete'] as const, volume: undefined,
    expiresAt: 1000 + 60_000,
  }), /entire volume root/);
  registry.grantLocally({ ...base, expiresAt: 1000 + 15 * 60_000 });
  assert.equal(registry.active('owner','device').length, 1);
});


test('authorization fails if a directory becomes a junction after volume inspection', async t => {
  const { dir } = await fixture(t);
  for (const mode of ['new', 'existing'] as const) {
    const root = path.join(dir, 'safe-' + mode);
    const outside = path.join(dir, 'outside-' + mode);
    await fs.mkdir(root);
    await fs.mkdir(outside);
    if (mode === 'existing') {
      await fs.writeFile(path.join(root, 'item.txt'), 'authorized');
      await fs.writeFile(path.join(outside, 'item.txt'), 'not-authorized');
    }
    let replaced = false;
    const policy = new PathPolicy([root], {
      platform: 'win32',
      volumeResolver: async () => {
        if (!replaced) {
          await fs.rename(root, root + '-moved');
          try {
            await fs.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
          } catch (error) {
            await fs.rename(root + '-moved', root);
            t.skip('Junction/symlink not available: ' + String(error));
            throw error;
          }
          replaced = true;
        }
        return { ...USB, busType: 'NVMe', driveType: 'Fixed' };
      },
    });
    const target = path.join(root, 'item.txt');
    await assert.rejects(
      mode === 'new'
        ? () => policy.authorizeForCreate(target, 'write')
        : () => policy.authorizeExisting(target, 'write'),
      (error: unknown) => error instanceof PathDeniedError &&
        error.details.reason === 'PATH_CHANGED_DURING_AUTHORIZATION',
    );
    assert.equal(replaced, true);
    if (mode === 'existing') {
      assert.equal(await fs.readFile(path.join(outside, 'item.txt'), 'utf8'), 'not-authorized');
    } else {
      await assert.rejects(() => fs.stat(path.join(outside, 'item.txt')));
    }
  }
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
