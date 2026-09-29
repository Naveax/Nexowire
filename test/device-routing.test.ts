import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeviceRoutingEntries,
  filterDeviceRoutes,
} from '../src/devices/routing.js';
import type { DeviceRecord } from '../src/devices/directory.js';

const records: DeviceRecord[] = [
  {
    id: 'desktop',
    name: 'Desktop',
    platform: 'win32',
    arch: 'x64',
    agentVersion: '1.0.0',
    capabilities: ['shell.exec', 'browser.snapshot'],
    firstSeenAt: '2026-09-29T00:00:00.000Z',
    lastSeenAt: '2026-09-30T00:00:00.000Z',
    lastConnectedAt: '2026-09-30T00:00:00.000Z',
    connectionCount: 3,
  },
  {
    id: 'laptop',
    name: 'Laptop',
    platform: 'linux',
    arch: 'x64',
    agentVersion: '1.0.0',
    capabilities: ['shell.exec', 'files.read'],
    firstSeenAt: '2026-09-28T00:00:00.000Z',
    lastSeenAt: '2026-09-29T00:00:00.000Z',
    lastConnectedAt: '2026-09-29T00:00:00.000Z',
    lastDisconnectedAt: '2026-09-29T01:00:00.000Z',
    connectionCount: 1,
  },
];

test('routing view merges persistent history, live routes, and aliases', () => {
  const aliases = new Map<string, readonly string[]>([
    ['desktop', ['main-pc']],
    ['laptop', ['linux-box']],
  ]);
  const devices = buildDeviceRoutingEntries({
    records,
    targets: [
      {
        id: 'desktop',
        name: 'Desktop Live',
        providerId: 'native-agent',
        platform: 'win32',
        online: true,
        capabilities: [
          'shell.exec',
          'browser.snapshot',
          'browser.click',
        ],
      },
    ],
    aliasesByDevice: aliases,
  });

  assert.equal(devices.length, 2);
  assert.equal(devices[0]?.id, 'desktop');
  assert.equal(devices[0]?.online, true);
  assert.equal(devices[0]?.name, 'Desktop Live');
  assert.deepEqual(devices[0]?.aliases, ['main-pc']);
  assert.deepEqual(devices[0]?.capabilities, [
    'browser.click',
    'browser.snapshot',
    'shell.exec',
  ]);

  const laptop = devices.find((device) => device.id === 'laptop');
  assert.ok(laptop);
  assert.equal(laptop.online, false);
  assert.equal(laptop.routes.length, 0);
});

test('route filtering never silently selects a different machine', () => {
  const devices = buildDeviceRoutingEntries({
    records,
    targets: [
      {
        id: 'desktop',
        name: 'Desktop',
        providerId: 'native-agent',
        platform: 'win32',
        online: true,
        capabilities: ['shell.exec', 'browser.snapshot'],
      },
      {
        id: 'laptop',
        name: 'Laptop',
        providerId: 'native-agent',
        platform: 'linux',
        online: true,
        capabilities: ['shell.exec', 'files.read'],
      },
    ],
    aliasesByDevice: new Map([
      ['desktop', ['main-pc']],
      ['laptop', ['linux-box']],
    ]),
  });

  assert.deepEqual(
    filterDeviceRoutes(devices, {
      platform: 'win32',
      requiredCapabilities: ['browser.snapshot'],
    }).map((device) => device.id),
    ['desktop'],
  );

  assert.deepEqual(
    filterDeviceRoutes(devices, {
      nameContains: 'linux',
      requiredCapabilities: ['shell.exec'],
    }).map((device) => device.id),
    ['laptop'],
  );

  assert.deepEqual(
    filterDeviceRoutes(devices, {
      deviceId: 'missing-device',
      requiredCapabilities: ['shell.exec'],
    }),
    [],
  );
});
