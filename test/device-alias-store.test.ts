import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DeviceAliasStore } from '../src/devices/alias-store.js';

test('device aliases are normalized, persistent, replaceable, and deletable', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-device-aliases-'),
  );

  try {
    const store = new DeviceAliasStore(root);
    await store.initialize();

    const first = await store.set('Main-PC', 'device-1');
    assert.equal(first.alias, 'main-pc');
    assert.equal(first.deviceId, 'device-1');
    assert.equal(await store.resolve('MAIN-PC'), 'device-1');
    assert.deepEqual(await store.aliasesForDevice('device-1'), ['main-pc']);

    const replaced = await store.set('main-pc', 'device-2');
    assert.equal(replaced.alias, 'main-pc');
    assert.equal(replaced.deviceId, 'device-2');
    assert.equal(replaced.createdAt, first.createdAt);
    assert.notEqual(replaced.updatedAt, '');

    const reloaded = new DeviceAliasStore(root);
    await reloaded.initialize();
    assert.equal(await reloaded.resolve('Main-PC'), 'device-2');
    assert.deepEqual(await reloaded.aliasesForDevice('device-1'), []);
    assert.deepEqual(await reloaded.aliasesForDevice('device-2'), ['main-pc']);

    assert.deepEqual(await reloaded.delete('MAIN-PC'), {
      alias: 'main-pc',
      deleted: true,
    });
    assert.equal(await reloaded.resolve('main-pc'), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('device aliases reject path-like and ambiguous names', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-device-aliases-invalid-'),
  );

  try {
    const store = new DeviceAliasStore(root);
    for (const alias of ['', '../pc', 'pc/name', 'pc name', '.hidden']) {
      await assert.rejects(() => store.set(alias, 'device-1'));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
