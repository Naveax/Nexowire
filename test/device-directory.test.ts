import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DeviceDirectory } from '../src/devices/directory.js';

test('device directory persists connection history without payload data', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-device-directory-'),
  );

  try {
    const first = new DeviceDirectory(root);
    await first.initialize();

    await first.observeConnected(
      {
        id: 'device-a',
        name: 'Main PC',
        platform: 'win32',
        arch: 'x64',
        agentVersion: '1.2.3',
        capabilities: ['files.read', 'shell.exec', 'files.read'],
      },
      '2026-09-30T00:00:00.000Z',
    );
    await first.observeDisconnected(
      'device-a',
      '2026-09-30T00:10:00.000Z',
    );
    await first.observeConnected(
      {
        id: 'device-a',
        name: 'Main PC Renamed',
        platform: 'win32',
        arch: 'x64',
        agentVersion: '1.2.4',
        capabilities: ['shell.exec', 'files.read', 'browser.snapshot'],
      },
      '2026-09-30T00:20:00.000Z',
    );

    const record = await first.get('device-a');
    assert.ok(record);
    assert.equal(record.name, 'Main PC Renamed');
    assert.equal(record.connectionCount, 2);
    assert.equal(record.firstSeenAt, '2026-09-30T00:00:00.000Z');
    assert.equal(record.lastSeenAt, '2026-09-30T00:20:00.000Z');
    assert.equal(record.lastConnectedAt, '2026-09-30T00:20:00.000Z');
    assert.equal(record.lastDisconnectedAt, '2026-09-30T00:10:00.000Z');
    assert.deepEqual(record.capabilities, [
      'browser.snapshot',
      'files.read',
      'shell.exec',
    ]);

    const reloaded = new DeviceDirectory(root);
    await reloaded.initialize();
    assert.deepEqual(await reloaded.get('device-a'), record);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
