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

test(
  'windows registry mutation round-trips and cleans up an isolated HKCU key',
  { skip: process.platform !== 'win32' },
  async () => {
    const suffix = Math.random().toString(36).slice(2);
    const keyPath = `Software\\NexowireTests\\${suffix}`;

    const setResult = (await executeWindowsCapability(
      'windows.registry.set',
      {
        hive: 'HKCU',
        path: keyPath,
        name: 'SampleValue',
        type: 'string',
        value: 'hello-registry',
        create_key: true,
      },
    )) as {
      data: {
        hive: string;
        path: string;
        name: string;
        kind: string;
        value: string;
        verified: boolean;
      };
    };

    assert.equal(setResult.data.hive, 'HKCU');
    assert.equal(setResult.data.path, keyPath);
    assert.equal(setResult.data.name, 'SampleValue');
    assert.equal(setResult.data.kind, 'String');
    assert.equal(setResult.data.value, 'hello-registry');
    assert.equal(setResult.data.verified, true);

    const readResult = (await executeWindowsCapability(
      'windows.registry.read',
      {
        hive: 'HKCU',
        path: keyPath,
        name: 'SampleValue',
        include_subkeys: false,
      },
    )) as {
      data: {
        values: Array<{ name: string; kind: string; value: string }>;
      };
    };
    assert.equal(readResult.data.values.length, 1);
    assert.equal(readResult.data.values[0]?.value, 'hello-registry');

    const deleteValue = (await executeWindowsCapability(
      'windows.registry.delete',
      {
        hive: 'HKCU',
        path: keyPath,
        name: 'SampleValue',
      },
    )) as { data: { deleted: boolean; verified: boolean } };
    assert.equal(deleteValue.data.deleted, true);
    assert.equal(deleteValue.data.verified, true);

    const setDefault = (await executeWindowsCapability(
      'windows.registry.set',
      {
        hive: 'HKCU',
        path: keyPath,
        name: '',
        type: 'string',
        value: 'hello-default-registry',
      },
    )) as {
      data: {
        name: string;
        kind: string;
        value: string;
        verified: boolean;
      };
    };
    assert.equal(setDefault.data.name, '');
    assert.equal(setDefault.data.kind, 'String');
    assert.equal(setDefault.data.value, 'hello-default-registry');
    assert.equal(setDefault.data.verified, true);

    const readDefault = (await executeWindowsCapability(
      'windows.registry.read',
      {
        hive: 'HKCU',
        path: keyPath,
        name: '',
        include_subkeys: false,
      },
    )) as {
      data: {
        values: Array<{ name: string; kind: string; value: string }>;
      };
    };
    assert.deepEqual(readDefault.data.values, [
      {
        name: '',
        kind: 'String',
        value: 'hello-default-registry',
      },
    ]);

    const deleteDefault = (await executeWindowsCapability(
      'windows.registry.delete',
      {
        hive: 'HKCU',
        path: keyPath,
        name: '',
      },
    )) as { data: { name: string; deleted: boolean; verified: boolean } };
    assert.equal(deleteDefault.data.name, '');
    assert.equal(deleteDefault.data.deleted, true);
    assert.equal(deleteDefault.data.verified, true);

    const largeValue =
      'Nexowire-stdin-ç-🚀-' + 'x'.repeat(65_536);
    const largeSet = (await executeWindowsCapability(
      'windows.registry.set',
      {
        hive: 'HKCU',
        path: keyPath,
        name: 'LargeInput',
        type: 'string',
        value: largeValue,
      },
    )) as {
      data: {
        value: string;
        verified: boolean;
      };
    };
    assert.equal(largeSet.data.verified, true);
    assert.equal(largeSet.data.value, largeValue);

    const largeDelete = (await executeWindowsCapability(
      'windows.registry.delete',
      {
        hive: 'HKCU',
        path: keyPath,
        name: 'LargeInput',
      },
    )) as { data: { deleted: boolean; verified: boolean } };
    assert.equal(largeDelete.data.deleted, true);
    assert.equal(largeDelete.data.verified, true);

    const deleteKey = (await executeWindowsCapability(
      'windows.registry.delete',
      {
        hive: 'HKCU',
        path: keyPath,
        recursive: true,
      },
    )) as { data: { deleted: boolean; verified: boolean } };
    assert.equal(deleteKey.data.deleted, true);
    assert.equal(deleteKey.data.verified, true);
  },
);

test(
  'windows mutation selectors reject broad or incomplete requests before mutation',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(
      () =>
        executeWindowsCapability('windows.task.control', {
          name: '*',
          path: '\\',
          action: 'disable',
        }),
      /exact task name/,
    );

    await assert.rejects(
      () =>
        executeWindowsCapability('windows.firewall.control', {
          name: '*',
          action: 'disable',
        }),
      /exact rule name/,
    );

    await assert.rejects(
      () =>
        executeWindowsCapability('windows.firewall.control', {
          name: 'DefinitelyMissingNexowireRule',
          action: 'set_action',
        }),
      /rule_action is required/,
    );

    await assert.rejects(
      () =>
        executeWindowsCapability('windows.registry.set', {
          hive: 'HKCU',
          path: 'Software\\NexowireTests',
          name: 'BadQword',
          type: 'qword',
          value: '9223372036854775808',
          create_key: true,
        }),
      /signed 64-bit range/,
    );

    await assert.rejects(
      () =>
        executeWindowsCapability('windows.task.control', {
          name: 'DefinitelyMissingNexowireTask',
          path: '\\',
          action: 'disable',
        }),
      /Expected exactly one scheduled task, found 0/,
    );

    await assert.rejects(
      () =>
        executeWindowsCapability('windows.firewall.control', {
          name: 'DefinitelyMissingNexowireFirewallRule',
          action: 'disable',
        }),
      /Expected exactly one firewall rule, found 0/,
    );
  },
);
