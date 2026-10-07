import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startPrivilegedBroker,
} from '../src/agent/privileged-broker.js';

test(
  'privileged broker health is authenticated and reports elevated readiness',
  { skip: process.platform !== 'win32' },
  async () => {
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
      assert.deepEqual(await allowed.json(), {
        ok: true,
        elevated: true,
      });

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
