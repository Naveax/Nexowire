import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { acquireNativeAgentSingleton } from '../src/agent/native-agent-singleton.js';

test('native agent singleton does not add a non-Windows runtime dependency', async () => {
  const lease = await acquireNativeAgentSingleton('test-' + randomUUID(), {
    platform: 'linux',
  });
  assert.equal(lease, null);
});

test(
  'Windows named pipe lease prevents duplicate native agents and releases after close',
  { skip: process.platform !== 'win32' },
  async () => {
    const identity = 'nexowire-agent-test-' + randomUUID();
    const options = { platform: 'win32' as const, homeDir: os.homedir() };
    const first = await acquireNativeAgentSingleton(identity, options);
    assert.ok(first);
    try {
      await assert.rejects(
        () => acquireNativeAgentSingleton(identity, options),
        /AGENT_ALREADY_RUNNING/,
      );
      const differentIdentity = await acquireNativeAgentSingleton(
        identity + '-different',
        options,
      );
      assert.ok(differentIdentity);
      await differentIdentity.close();
    } finally {
      await first.close();
    }
    const afterClose = await acquireNativeAgentSingleton(identity, options);
    assert.ok(afterClose);
    await afterClose.close();
  },
);
