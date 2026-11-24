import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  startPrivilegedBroker,
  isWindowsProcessElevated,
} from '../src/agent/privileged-broker.js';

test(
  'privileged broker health authenticates and reports actual token elevation',
  { skip: process.platform !== 'win32' },
  async () => {
    // Resolve expected metadata independently of the Broker's runtime version module.
    const packageVersion: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ).version;
    assert.equal(typeof packageVersion, 'string');
    assert.notEqual(packageVersion, '');
    const token = 'health-token-0123456789';
    const handle = await startPrivilegedBroker({
      host: '127.0.0.1',
      port: 0,
      tokens: [token],
      requireElevation: false,
    });
    try {
      const denied = await fetch(handle.url + '/health');
      assert.equal(denied.status, 401);

      const allowed = await fetch(handle.url + '/health', {
        headers: {
          authorization: 'Bearer ' + token,
        },
      });
      assert.equal(allowed.status, 200);
      const health = await allowed.json() as {
        ok?: boolean;
        elevated?: boolean;
        version?: string;
      };
      assert.equal(health.ok, true);
      // requireElevation:false is fixture startup permission, NOT an OS
      // HIGH-token grant. Compare against the independent Windows token probe.
      assert.equal(health.elevated, isWindowsProcessElevated());
      assert.equal(health.version, packageVersion);

      const wrongMethod = await fetch(handle.url + '/health', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
        },
      });
      assert.equal(wrongMethod.status, 405);
    } finally {
      await handle.close();
    }
  },
);
