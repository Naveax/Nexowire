import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  DeviceRoutingPolicyError,
  DeviceRoutingPolicyStore,
} from '../src/devices/routing-policy-store.js';

test('routing policies persist deterministic unique and priority modes', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-routing-policy-'),
  );

  try {
    const first = new DeviceRoutingPolicyStore(root);
    await first.initialize();

    const unique = await first.set('Windows-Coding', {
      selection: 'unique_only',
      group: 'work',
      platform: 'WIN32',
      requiredCapabilities: [
        'shell.exec',
        'files.read',
        'shell.exec',
      ],
    });
    assert.equal(unique.name, 'windows-coding');
    assert.equal(unique.platform, 'win32');
    assert.deepEqual(unique.requiredCapabilities, [
      'files.read',
      'shell.exec',
    ]);

    const priority = await first.set('Build-Farm', {
      selection: 'priority',
      priorityDeviceIds: [
        'desktop',
        'laptop',
        'desktop',
      ],
      requiredCapabilities: ['workspace.checks'],
    });
    assert.deepEqual(priority.priorityDeviceIds, [
      'desktop',
      'laptop',
    ]);

    const second = new DeviceRoutingPolicyStore(root);
    await second.initialize();
    assert.deepEqual(
      (await second.get('WINDOWS-CODING'))?.requiredCapabilities,
      ['files.read', 'shell.exec'],
    );
    assert.equal(
      (await second.get('BUILD-FARM'))?.selection,
      'priority',
    );

    assert.deepEqual(await second.delete('build-farm'), {
      name: 'build-farm',
      deleted: true,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('priority routing policies require an explicit stable target order', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-routing-policy-empty-'),
  );

  try {
    const store = new DeviceRoutingPolicyStore(root);
    await assert.rejects(
      () =>
        store.set('priority', {
          selection: 'priority',
          priorityDeviceIds: [],
        }),
      (error: unknown) =>
        error instanceof DeviceRoutingPolicyError &&
        error.code === 'ROUTING_POLICY_PRIORITY_EMPTY',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
