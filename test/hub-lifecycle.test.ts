import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHubLauncher,
  persistedHubEnvironment,
  planHubInstall,
  shouldRestartHubAfterInstall,
} from '../src/hub/hub-lifecycle.js';
import {
  buildHubBootLauncher,
  parsePersistedHubLauncherEnvironment,
} from '../src/hub/hub-boot-lifecycle.js';

test('Hub launcher persists only non-secret self-host configuration', () => {
  const env = {
    NEXOWIRE_STATE_DIR: 'C:\\Users\\User\\.nexowire\\hub',
    NEXOWIRE_HTTP_HOST: '127.0.0.1',
    NEXOWIRE_HTTP_PORT: '43110',
    NEXOWIRE_HTTP_ALLOWED_HOSTS:
      'desktop-ondd84s.tail10f02d.ts.net',
    NEXOWIRE_CONTROL_PLANE_URL:
      'https://control.example.test',
    NEXOWIRE_CONTROL_PLANE_AUTH_TIMEOUT_MS: '2500',
    NEXOWIRE_MCP_RESOURCE_URL:
      'https://desktop.example.test/mcp',
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE:
      'C:\\Users\\User\\.nexowire\\secrets\\control-plane-service.dpapi.json',
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
  assert.match(launcher, /NEXOWIRE_CONTROL_PLANE_URL/);
  assert.match(
    launcher,
    /NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE/,
  );
  assert.match(launcher, /NEXOWIRE_MCP_RESOURCE_URL/);
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
    'NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN',
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


test('Hub install reuses an existing Scheduled Task instead of re-registering it', () => {
  assert.deepEqual(
    planHubInstall({
      installed: false,
      state: 'not-installed',
      previousLauncher: null,
      nextLauncher: 'next',
    }),
    {
      registerTask: true,
      restartTask: false,
      startTask: true,
    },
  );

  assert.deepEqual(
    planHubInstall({
      installed: true,
      state: 'running',
      previousLauncher: 'same',
      nextLauncher: 'same',
    }),
    {
      registerTask: false,
      restartTask: false,
      startTask: false,
    },
  );

  assert.deepEqual(
    planHubInstall({
      installed: true,
      state: 'running',
      previousLauncher: 'old',
      nextLauncher: 'new',
    }),
    {
      registerTask: false,
      restartTask: true,
      startTask: false,
    },
  );

  assert.deepEqual(
    planHubInstall({
      installed: true,
      state: 'ready',
      previousLauncher: 'old',
      nextLauncher: 'new',
    }),
    {
      registerTask: false,
      restartTask: false,
      startTask: true,
    },
  );
});


test('Hub lifecycle persists control-plane secret references but never the service token value', () => {
  const env = {
    NEXOWIRE_CONTROL_PLANE_URL:
      'https://control.example.test',
    NEXOWIRE_MCP_RESOURCE_URL:
      'https://relay.example.test/mcp',
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE:
      'C:\\Secrets\\control-plane.txt',
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE:
      'C:\\Secrets\\control-plane.dpapi.json',
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_PLATFORM_NAME:
      'nexowire-control-plane-service',
  };

  assert.deepEqual(
    persistedHubEnvironment(env),
    env,
  );

  const launcher = buildHubLauncher({
    env,
    execPath: 'node.exe',
    cliEntrypoint: 'cli.js',
  });
  assert.match(
    launcher,
    /NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE/,
  );
  assert.match(
    launcher,
    /NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_PLATFORM_NAME/,
  );
  assert.equal(
    launcher.includes(
      'NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN=',
    ),
    false,
  );
});

test('pre-logon Hub parser recovers persisted environment from the user launcher', () => {
  const launcher = [
    "$env:NEXOWIRE_HTTP_HOST='127.0.0.1'",
    "$env:NEXOWIRE_HTTP_PORT='43110'",
    "$env:NEXOWIRE_CONTROL_PLANE_URL='https://control.example.test'",
    "$env:NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE='C:\\Users\\User\\service.dpapi.json'",
    "& 'node.exe' 'cli.js' 'http'",
  ].join('\r\n');

  assert.deepEqual(
    parsePersistedHubLauncherEnvironment(launcher),
    {
      NEXOWIRE_HTTP_HOST: '127.0.0.1',
      NEXOWIRE_HTTP_PORT: '43110',
      NEXOWIRE_CONTROL_PLANE_URL:
        'https://control.example.test',
      NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE:
        'C:\\Users\\User\\service.dpapi.json',
    },
  );
});

test('pre-logon Hub launcher tracks the SYSTEM child pid and protected secret reference', () => {
  const launcher = buildHubBootLauncher({
    env: {
      NEXOWIRE_HTTP_HOST: '127.0.0.1',
      NEXOWIRE_HTTP_PORT: '43110',
      NEXOWIRE_CONTROL_PLANE_URL:
        'https://control.example.test',
      NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE:
        'C:\\ProgramData\\Nexowire\\hub-boot\\service.machine.dpapi.json',
    },
    executable: 'C:\\Program Files\\Nexowire\\node.exe',
    args: [
      'C:\\Program Files\\Nexowire\\cli.js',
      'http',
    ],
    pidFile:
      'C:\\ProgramData\\Nexowire\\hub-boot\\hub.pid',
  });

  assert.match(launcher, /service\.machine\.dpapi\.json/);
  assert.match(launcher, /Start-Process/);
  assert.match(launcher, /hub\.pid/);
  assert.match(launcher, /WaitForExit/);
});

