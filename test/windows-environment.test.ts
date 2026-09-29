import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWindowsEnvironmentCapability } from '../src/agent/windows-environment.js';

test(
  'Windows process environment set/read/list/delete round-trips',
  { skip: process.platform !== 'win32' },
  async () => {
    const name = 'NEXOWIRE_TEST_ENV_' + process.pid + '_' + Date.now();
    const value = 'hello-environment';

    try {
      const set = (await executeWindowsEnvironmentCapability(
        'windows.environment.set',
        {
          scope: 'process',
          name,
          value,
        },
      )) as {
        data: { verified: boolean; processUpdated: boolean };
      };
      assert.equal(set.data.verified, true);
      assert.equal(set.data.processUpdated, true);

      const read = (await executeWindowsEnvironmentCapability(
        'windows.environment.read',
        {
          scope: 'process',
          names: [name],
        },
      )) as {
        data: {
          values: Array<{
            name: string;
            exists: boolean;
            value: string | null;
            redacted: boolean;
          }>;
        };
      };
      assert.equal(read.data.values[0]?.name, name);
      assert.equal(read.data.values[0]?.exists, true);
      assert.equal(read.data.values[0]?.value, value);
      assert.equal(read.data.values[0]?.redacted, false);

      const listed = (await executeWindowsEnvironmentCapability(
        'windows.environment.list',
        {
          scope: 'process',
          prefix: name,
          limit: 10,
        },
      )) as {
        data: {
          names: Array<{ name: string; sensitive: boolean }>;
          truncated: boolean;
        };
      };
      assert.ok(listed.data.names.some((item) => item.name === name));
      assert.equal(listed.data.truncated, false);
    } finally {
      await executeWindowsEnvironmentCapability(
        'windows.environment.delete',
        {
          scope: 'process',
          name,
        },
      );
    }

    const after = (await executeWindowsEnvironmentCapability(
      'windows.environment.read',
      {
        scope: 'process',
        names: [name],
      },
    )) as {
      data: { values: Array<{ exists: boolean; value: string | null }> };
    };
    assert.equal(after.data.values[0]?.exists, false);
    assert.equal(after.data.values[0]?.value, null);
  },
);

test(
  'sensitive process environment values are redacted by default',
  { skip: process.platform !== 'win32' },
  async () => {
    const name = 'NEXOWIRE_TEST_API_TOKEN_' + process.pid;
    const value = 'sensitive-fixture-value';

    try {
      await executeWindowsEnvironmentCapability('windows.environment.set', {
        scope: 'process',
        name,
        value,
      });

      const redacted = (await executeWindowsEnvironmentCapability(
        'windows.environment.read',
        {
          scope: 'process',
          names: [name],
        },
      )) as {
        data: {
          values: Array<{
            sensitive: boolean;
            redacted: boolean;
            value: string | null;
          }>;
        };
      };
      assert.equal(redacted.data.values[0]?.sensitive, true);
      assert.equal(redacted.data.values[0]?.redacted, true);
      assert.equal(redacted.data.values[0]?.value, '<redacted>');

      const revealed = (await executeWindowsEnvironmentCapability(
        'windows.environment.read',
        {
          scope: 'process',
          names: [name],
          reveal_sensitive: true,
        },
      )) as {
        data: {
          values: Array<{ redacted: boolean; value: string | null }>;
        };
      };
      assert.equal(revealed.data.values[0]?.redacted, false);
      assert.equal(revealed.data.values[0]?.value, value);
    } finally {
      await executeWindowsEnvironmentCapability(
        'windows.environment.delete',
        {
          scope: 'process',
          name,
        },
      );
    }
  },
);

test(
  'Windows user environment mutation is verified and cleaned up',
  { skip: process.platform !== 'win32' },
  async () => {
    const name = 'NEXOWIRE_TEST_USER_ENV_' + process.pid + '_' + Date.now();
    const value = 'user-scope-value';

    try {
      const set = (await executeWindowsEnvironmentCapability(
        'windows.environment.set',
        {
          scope: 'user',
          name,
          value,
        },
      )) as {
        data: {
          scope: string;
          verified: boolean;
          processUpdated: boolean;
          requiresNewProcess: boolean;
        };
      };
      assert.equal(set.data.scope, 'user');
      assert.equal(set.data.verified, true);
      assert.equal(set.data.processUpdated, false);
      assert.equal(set.data.requiresNewProcess, true);

      const read = (await executeWindowsEnvironmentCapability(
        'windows.environment.read',
        {
          scope: 'user',
          names: [name],
        },
      )) as {
        data: {
          values: Array<{ exists: boolean; value: string | null }>;
        };
      };
      assert.equal(read.data.values[0]?.exists, true);
      assert.equal(read.data.values[0]?.value, value);
    } finally {
      await executeWindowsEnvironmentCapability(
        'windows.environment.delete',
        {
          scope: 'user',
          name,
        },
      );
    }

    const after = (await executeWindowsEnvironmentCapability(
      'windows.environment.read',
      {
        scope: 'user',
        names: [name],
      },
    )) as {
      data: { values: Array<{ exists: boolean }> };
    };
    assert.equal(after.data.values[0]?.exists, false);
  },
);

test(
  'Windows environment control rejects invalid names before mutation',
  { skip: process.platform !== 'win32' },
  async () => {
    await assert.rejects(
      () =>
        executeWindowsEnvironmentCapability('windows.environment.set', {
          scope: 'process',
          name: 'BAD=NAME',
          value: 'x',
        }),
      /cannot contain NUL or equals/,
    );
  },
);
