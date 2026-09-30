import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DeviceGroupStore } from '../src/devices/group-store.js';

test('device groups normalize, deduplicate, persist, replace, and delete', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-device-groups-'),
  );

  try {
    const first = new DeviceGroupStore(root);
    await first.initialize();

    const created = await first.set('Work-PCs', [
      'device-b',
      'device-a',
      'device-a',
    ]);
    assert.equal(created.name, 'work-pcs');
    assert.deepEqual(created.deviceIds, ['device-a', 'device-b']);

    const reloaded = new DeviceGroupStore(root);
    await reloaded.initialize();
    assert.deepEqual(await reloaded.get('WORK-PCS'), created);

    const replaced = await reloaded.set('work-pcs', ['device-c']);
    assert.equal(replaced.createdAt, created.createdAt);
    assert.deepEqual(replaced.deviceIds, ['device-c']);

    assert.deepEqual(await reloaded.delete('WORK-PCS'), {
      name: 'work-pcs',
      deleted: true,
    });
    assert.equal(await reloaded.get('work-pcs'), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('device groups reject empty and unsafe names', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-device-groups-invalid-'),
  );

  try {
    const store = new DeviceGroupStore(root);
    await assert.rejects(() => store.set('group', []));
    for (const name of ['', '../x', 'a/b', 'a b', '.hidden']) {
      await assert.rejects(() => store.set(name, ['device-a']));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
