import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrivilegedBrokerLauncher,
  privilegedBrokerTaskStatus,
} from '../src/agent/privileged-broker-lifecycle.js';

test('broker task launcher preserves runtime args and never persists plaintext broker tokens', () => {
  const launcher = buildPrivilegedBrokerLauncher({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    execArgv: ['--import', 'tsx'],
    cliEntrypoint: "C:\\Work\\Nexowire O'Brien\\src\\cli.ts",
    env: {
      NEXOWIRE_PRIVILEGED_BROKER_HOST: '127.0.0.1',
      NEXOWIRE_PRIVILEGED_BROKER_PORT: '43112',
      NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE:
        "C:\\Users\\User\\Nexowire O'Brien\\broker.dpapi.json",
      NEXOWIRE_PRIVILEGED_BROKER_TOKEN: 'must-not-persist',
      NEXOWIRE_PRIVILEGED_BROKER_TOKENS:
        'must-not-persist-either',
    },
  });

  assert.match(
    launcher,
    /'C:\\Program Files\\nodejs\\node\.exe'/,
  );
  assert.match(launcher, /'--import' 'tsx'/);
  assert.match(launcher, /'privileged-broker' 'run'/);
  assert.match(launcher, /O''Brien/);
  assert.equal(launcher.includes('must-not-persist'), false);
});

test(
  'broker task status is Windows-only',
  { skip: process.platform === 'win32' },
  async () => {
    await assert.rejects(
      () =>
        privilegedBrokerTaskStatus({
          taskName: 'Nexowire Test Broker',
        }),
      /only on Windows/i,
    );
  },
);
