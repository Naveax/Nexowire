import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseSelfHostBootstrapArgs } from '../src/self-host-bootstrap.js';

test('self-host bootstrap parser normalizes easy-connect options', () => {
  const parsed = parseSelfHostBootstrapArgs([
    '--device-name',
    'work-pc',
    '--allow-root',
    '.',
    '--port=43120',
    '--ttl-days',
    '365',
    '--tailscale-funnel',
  ]);

  assert.equal(parsed.deviceName, 'work-pc');
  assert.equal(parsed.port, 43120);
  assert.equal(parsed.ttlDays, 365);
  assert.equal(parsed.tailscaleFunnel, true);
  assert.deepEqual(parsed.allowedRoots, ['.']);
});

test('self-host bootstrap parser rejects unknown and malformed options', () => {
  assert.throws(
    () => parseSelfHostBootstrapArgs(['--port=0']),
    /positive integer/,
  );
  assert.throws(
    () => parseSelfHostBootstrapArgs(['--mystery']),
    /Unknown node bootstrap option/,
  );
  assert.doesNotThrow(() =>
    path.resolve(
      parseSelfHostBootstrapArgs(['--allow-root=.']).allowedRoots?.[0] ??
        '.',
    ),
  );
});
