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

test(
  'windows registry, tasks, event log, and firewall tools return structured data',
  { skip: process.platform !== 'win32' },
  async () => {
    const registry = (await executeWindowsCapability(
      'windows.registry.read',
      {
        hive: 'HKCU',
        path: 'Software',
        include_subkeys: true,
        limit: 10,
      },
    )) as {
      data: {
        hive: string;
        path: string;
        values: unknown[];
        subkeys: string[];
      };
    };
    assert.equal(registry.data.hive, 'HKCU');
    assert.equal(registry.data.path, 'Software');
    assert.ok(Array.isArray(registry.data.values));
    assert.ok(Array.isArray(registry.data.subkeys));

    const tasks = (await executeWindowsCapability('windows.tasks', {
      state: 'all',
      limit: 5,
    })) as { data: { tasks: unknown[] } };
    assert.ok(Array.isArray(tasks.data.tasks));

    const events = (await executeWindowsCapability(
      'windows.eventlog.query',
      {
        log_name: 'System',
        since_minutes: 1440,
        max_events: 5,
      },
    )) as { data: { events: unknown[] } };
    assert.ok(Array.isArray(events.data.events));

    const firewall = (await executeWindowsCapability(
      'windows.firewall.rules',
      {
        direction: 'all',
        action: 'all',
        limit: 5,
      },
    )) as { data: { rules: unknown[] } };
    assert.ok(Array.isArray(firewall.data.rules));
  },
);
