import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  buildLinuxUserUnit,
  buildMacLaunchAgentPlist,
  buildNativeAgentLauncher,
  nativeAgentLifecycleStatus,
  persistedNativeAgentEnvironment,
} from '../src/agent/native-agent-lifecycle.js';

test('native-agent launcher persists only safe configuration references', () => {
  const env = {
    NEXOWIRE_HUB_WS_URL: 'wss://hub.example.test/agent',
    NEXOWIRE_DEVICE_NAME: "Operator's PC",
    NEXOWIRE_AGENT_TOKEN_DPAPI_FILE:
      "C:\\Users\\User\\Nexowire O'Brien\\agent.dpapi.json",
    NEXOWIRE_PRIVILEGE_MODE: 'broker',
  };

  const persisted = persistedNativeAgentEnvironment(env);
  assert.deepEqual(persisted, env);

  const launcher = buildNativeAgentLauncher({
    platform: 'win32',
    env,
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    execArgv: ['--import', 'tsx'],
    cliEntrypoint: "C:\\Work\\Nexowire O'Brien\\src\\cli.ts",
  });

  assert.match(launcher, /NEXOWIRE_HUB_WS_URL/);
  assert.match(launcher, /NEXOWIRE_AGENT_TOKEN_DPAPI_FILE/);
  assert.match(launcher, /O''Brien/);
  assert.match(launcher, /'agent' 'run'/);
  assert.equal(launcher.includes('NEXOWIRE_AGENT_TOKEN='), false);
});

test('native-agent lifecycle refuses plaintext secret persistence', () => {
  for (const [name, value] of [
    ['NEXOWIRE_AGENT_TOKEN', 'secret-agent'],
    ['NEXOWIRE_AGENT_TOKENS', 'secret-a,secret-b'],
    ['NEXOWIRE_PRIVILEGED_BROKER_TOKEN', 'secret-broker'],
    ['NEXOWIRE_PRIVILEGED_BROKER_TOKENS', 'secret-broker-a'],
  ] as const) {
    assert.throws(
      () =>
        buildNativeAgentLauncher({
          platform: 'linux',
          env: { [name]: value },
          execPath: '/usr/bin/node',
          cliEntrypoint: '/opt/nexowire/dist/src/cli.js',
        }),
      /refuses to persist plaintext secret variable/,
      name,
    );
  }
});

test('Linux user unit uses restart and default-target autostart semantics', () => {
  const unit = buildLinuxUserUnit({
    platform: 'linux',
    homeDir: '/home/nexowire',
    rootDir: '/home/nexowire/.nexowire/native-agent',
    linuxUnitName: 'nexowire-agent.service',
  });

  assert.match(unit, /After=network-online\.target/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /RestartSec=2/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(
    unit,
    /ExecStart=\/bin\/sh \/home\/nexowire\/\.nexowire\/native-agent\/launch\.sh/,
  );
});

test('Linux lifecycle status is safely not-installed without invoking systemd', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-agent-lifecycle-'),
  );
  try {
    const status = await nativeAgentLifecycleStatus({
      platform: 'linux',
      homeDir: root,
      rootDir: path.join(root, '.nexowire', 'native-agent'),
      env: {},
    });

    assert.equal(status.installed, false);
    assert.equal(status.state, 'not-installed');
    assert.equal(status.autostart, false);
    assert.equal(status.pid, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('macOS launcher and LaunchAgent persist references but not secret values', () => {
  const options = {
    platform: 'darwin' as const,
    homeDir: '/Users/nexowire',
    rootDir: '/Users/nexowire/.nexowire/native-agent',
    macLabel: 'com.nexowire.agent.test',
    env: {
      NEXOWIRE_HUB_WS_URL: 'wss://hub.example.test/agent',
      NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME: 'nexowire-agent-token',
    },
    execPath: '/usr/local/bin/node',
    cliEntrypoint: '/opt/nexowire/dist/src/cli.js',
  };

  const launcher = buildNativeAgentLauncher(options);
  const plist = buildMacLaunchAgentPlist(options);

  assert.match(
    launcher,
    /NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME='nexowire-agent-token'/,
  );
  assert.match(launcher, /'agent' 'run'/);
  assert.equal(launcher.includes('NEXOWIRE_AGENT_TOKEN='), false);

  assert.match(plist, /<string>com\.nexowire\.agent\.test<\/string>/);
  assert.match(
    plist,
    /<string>\/Users\/nexowire\/\.nexowire\/native-agent\/launch\.sh<\/string>/,
  );
  assert.match(plist, /<key>RunAtLoad<\/key>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
  assert.equal(plist.includes('nexowire-agent-token'), false);
});

test('macOS lifecycle status is safely not-installed without invoking launchctl', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-agent-macos-lifecycle-'),
  );
  try {
    const status = await nativeAgentLifecycleStatus({
      platform: 'darwin',
      homeDir: root,
      rootDir: path.join(root, '.nexowire', 'native-agent'),
      macLabel: 'com.nexowire.agent.test',
      uid: 501,
      env: {},
    });

    assert.equal(status.platform, 'darwin');
    assert.equal(status.installed, false);
    assert.equal(status.state, 'not-installed');
    assert.equal(status.autostart, false);
    assert.equal(status.pid, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unsupported lifecycle platforms fail closed', async () => {
  await assert.rejects(
    () =>
      nativeAgentLifecycleStatus({
        platform: 'aix',
      }),
    /supports Windows, Linux, and macOS/,
  );
});
