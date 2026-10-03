import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHubLauncher,
  persistedHubEnvironment,
} from '../src/hub/hub-lifecycle.js';

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
