import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  isPrivilegedBrokerCapability,
  privilegeRequirement,
} from '../src/security/privilege.js';
import {
  PrivilegedBrokerClient,
  PrivilegedBrokerError,
} from '../src/agent/privileged-broker-client.js';
import { startPrivilegedBroker } from '../src/agent/privileged-broker.js';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

test('privilege classifier routes only elevated Windows mutations', () => {
  assert.equal(
    privilegeRequirement('windows.service.control', {}),
    'elevated',
  );
  assert.equal(
    privilegeRequirement('windows.firewall.control', {}),
    'elevated',
  );
  assert.equal(
    privilegeRequirement('windows.task.control', {}),
    'elevated',
  );
  assert.equal(
    privilegeRequirement('windows.registry.set', {
      hive: 'HKLM',
    }),
    'elevated',
  );
  assert.equal(
    privilegeRequirement('windows.registry.delete', {
      hive: 'HKCU',
    }),
    'standard',
  );
  assert.equal(
    privilegeRequirement('windows.environment.set', {
      scope: 'machine',
    }),
    'elevated',
  );
  assert.equal(
    privilegeRequirement('windows.environment.set', {
      scope: 'user',
    }),
    'standard',
  );
  assert.equal(
    privilegeRequirement('files.write', {}),
    'standard',
  );

  assert.equal(
    isPrivilegedBrokerCapability('windows.firewall.control'),
    true,
  );
  assert.equal(
    isPrivilegedBrokerCapability('shell.exec'),
    false,
  );
});

test('privileged broker client refuses non-loopback URLs', () => {
  assert.throws(
    () =>
      new PrivilegedBrokerClient({
        url: 'http://10.0.0.5:43112',
        token: 'secret',
      }),
    /loopback/i,
  );
  assert.throws(
    () =>
      new PrivilegedBrokerClient({
        url: 'https://127.0.0.1:43112',
        token: 'secret',
      }),
    /loopback http/i,
  );
});

test('broker privilege mode fails closed when no broker is configured', async () => {
  const policy = new PathPolicy([os.homedir()]);

  await assert.rejects(
    () =>
      executeCapability(
        'windows.firewall.control',
        {
          name: 'example',
          action: 'enable',
        },
        policy,
        { privilegeMode: 'broker' },
      ),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'PRIVILEGED_BROKER_REQUIRED',
  );
});

test(
  'Windows privileged broker authenticates and isolates elevated execution',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const calls: Array<{
      capability: string;
      input: unknown;
    }> = [];

    const handle = await startPrivilegedBroker({
      host: '127.0.0.1',
      port: 0,
      tokens: ['broker-secret'],
      requireElevation: false,
      execute: async (capability, input) => {
        calls.push({ capability, input });
        return {
          data: {
            routed: true,
            capability,
          },
        };
      },
    });

    t.after(async () => {
      await handle.close();
    });

    const client = new PrivilegedBrokerClient({
      url: handle.url,
      token: 'broker-secret',
    });

    const response = (await client.execute(
      'windows.firewall.control',
      {
        name: 'test-rule',
        action: 'enable',
      },
    )) as {
      data?: {
        routed?: boolean;
        capability?: string;
      };
    };

    assert.equal(response.data?.routed, true);
    assert.equal(
      response.data?.capability,
      'windows.firewall.control',
    );
    assert.equal(calls.length, 1);

    const wrongToken = new PrivilegedBrokerClient({
      url: handle.url,
      token: 'wrong-secret',
    });
    await assert.rejects(
      () =>
        wrongToken.execute('windows.firewall.control', {
          name: 'test-rule',
          action: 'enable',
        }),
      (error: unknown) =>
        error instanceof PrivilegedBrokerError &&
        error.code === 'UNAUTHORIZED',
    );

    await assert.rejects(
      () =>
        client.execute('windows.registry.set', {
          hive: 'HKCU',
          path: 'Software\\Nexowire',
          name: 'x',
          type: 'string',
          value: 'y',
        }),
      (error: unknown) =>
        error instanceof PrivilegedBrokerError &&
        error.code === 'PRIVILEGED_BROKER_NOT_REQUIRED',
    );

    const policy = new PathPolicy([os.homedir()]);
    const routed = (await executeCapability(
      'windows.firewall.control',
      {
        name: 'test-rule',
        action: 'enable',
      },
      policy,
      {
        privilegeMode: 'broker',
        privilegedBroker: client,
      },
    )) as {
      data?: {
        routed?: boolean;
      };
    };
    assert.equal(routed.data?.routed, true);
    assert.equal(calls.length, 2);
  },
);
