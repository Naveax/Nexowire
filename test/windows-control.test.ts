import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWindowsCapability } from '../src/agent/windows-control.js';

test(
  'windows structured process/service/network snapshots return JSON',
  { skip: process.platform !== 'win32' },
  async () => {
    const processes = (await executeWindowsCapability('windows.processes', {
      pid: process.pid,
      include_command_line: false,
      limit: 10,
    })) as { data: { processes: Array<{ pid: number; name: string }> } };
    assert.ok(processes.data.processes.some((item) => item.pid === process.pid));

    const services = (await executeWindowsCapability('windows.services', {
      state: 'all',
      limit: 10,
    })) as { data: { services: Array<{ name: string; state: string }> } };
    assert.ok(Array.isArray(services.data.services));
    assert.ok(services.data.services.length > 0);

    const network = (await executeWindowsCapability(
      'windows.network.snapshot',
      { include_connections: false },
    )) as {
      data: {
        adapters: unknown[];
        addresses: unknown[];
        dns: unknown[];
        defaultRoutes: unknown[];
        tcpConnections: unknown[];
      };
    };
    assert.ok(Array.isArray(network.data.adapters));
    assert.ok(Array.isArray(network.data.addresses));
    assert.ok(Array.isArray(network.data.dns));
    assert.ok(Array.isArray(network.data.defaultRoutes));
    assert.deepEqual(network.data.tcpConnections, []);
  },
);

test(
  'windows service control validates startup type before mutation',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(
      () =>
        executeWindowsCapability('windows.service.control', {
          name: 'definitely-does-not-matter',
          action: 'set_startup',
        }),
      /startup_type is required/,
    );
  },
);
