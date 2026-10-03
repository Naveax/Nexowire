import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHubLauncher,
  persistedHubEnvironment,
  shouldRestartHubAfterInstall,
} from '../src/hub/hub-lifecycle.js';

test('Hub launcher persists only non-secret self-host configuration', () => {
  const env = {
    NEXOWIRE_STATE_DIR: 'C:\\Users\\User\\.nexowire\\hub',
    NEXOWIRE_HTTP_HOST: '127.0.0.1',
    NEXOWIRE_HTTP_PORT: '43110',
    NEXOWIRE_HTTP_ALLOWED_HOSTS:
      'desktop-ondd84s.tail10f02d.ts.net',
  };

  assert.deepEqual(persistedHubEnvironment(env), env);

  const launcher = buildHubLauncher({
    env,
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    cliEntrypoint: 'C:\\Tools\\nexowire\\dist\\src\\cli.js',
  });

  assert.match(launcher, /NEXOWIRE_STATE_DIR/);
  assert.match(launcher, /NEXOWIRE_HTTP_HOST/);
  assert.match(launcher, /NEXOWIRE_HTTP_PORT/);
  assert.match(launcher, /NEXOWIRE_HTTP_ALLOWED_HOSTS/);
  assert.match(
    launcher,
    /desktop-ondd84s\.tail10f02d\.ts\.net/,
  );
  assert.match(launcher, /'http'/);
  assert.equal(launcher.includes('NEXOWIRE_MCP_BEARER_TOKEN='), false);
  assert.equal(launcher.includes('NEXOWIRE_AGENT_TOKEN='), false);
});

test('Hub lifecycle refuses plaintext bearer persistence', () => {
  for (const name of [
    'NEXOWIRE_MCP_BEARER_TOKEN',
    'NEXOWIRE_MCP_BEARER_TOKENS',
    'NEXOWIRE_AGENT_TOKEN',
    'NEXOWIRE_AGENT_TOKENS',
  ]) {
    assert.throws(
      () =>
        buildHubLauncher({
          env: { [name]: 'secret' },
          execPath: 'node',
          cliEntrypoint: 'cli.js',
        }),
      /refuses to persist plaintext secret variable/,
    );
  }
});


test("Hub install restarts only when a running launcher's persisted config changed", () => {
  const oldLauncher =
    '$env:NEXOWIRE_HTTP_ALLOWED_HOSTS=\'old.example\'';
  const sameLauncher =
    '$env:NEXOWIRE_HTTP_ALLOWED_HOSTS=\'old.example\'';
  const newLauncher =
    '$env:NEXOWIRE_HTTP_ALLOWED_HOSTS=\'new.example\'';

  assert.equal(
    shouldRestartHubAfterInstall({
      wasRunning: true,
      previousLauncher: oldLauncher,
      nextLauncher: newLauncher,
    }),
    true,
  );
  assert.equal(
    shouldRestartHubAfterInstall({
      wasRunning: true,
      previousLauncher: oldLauncher,
      nextLauncher: sameLauncher,
    }),
    false,
  );
  assert.equal(
    shouldRestartHubAfterInstall({
      wasRunning: false,
      previousLauncher: oldLauncher,
      nextLauncher: newLauncher,
    }),
    false,
  );
  assert.equal(
    shouldRestartHubAfterInstall({
      wasRunning: true,
      previousLauncher: null,
      nextLauncher: newLauncher,
    }),
    true,
  );
});
