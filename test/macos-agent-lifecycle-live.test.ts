import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  installNativeAgentLifecycle,
  nativeAgentLifecycleStatus,
  restartNativeAgentLifecycle,
  startNativeAgentLifecycle,
  stopNativeAgentLifecycle,
  uninstallNativeAgentLifecycle,
} from '../src/agent/native-agent-lifecycle.js';

const enabled =
  process.platform === 'darwin' &&
  process.env.NEXOWIRE_LIVE_MACOS_AGENT_LIFECYCLE_TEST === '1';

test(
  'macOS LaunchAgent lifecycle installs, stops, starts, restarts, and uninstalls a real user job',
  { skip: !enabled, timeout: 45_000 },
  async (t) => {
    const temp = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-macos-lifecycle-live-'),
    );
    const rootDir = path.join(temp, '.nexowire', 'native-agent');
    const fixture = path.join(temp, 'fixture.mjs');
    const label =
      'com.nexowire.agent.ci.' +
      process.pid +
      '.' +
      Date.now();

    await fs.writeFile(
      fixture,
      [
        "process.on('SIGTERM', () => process.exit(0));",
        "process.on('SIGINT', () => process.exit(0));",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
      'utf8',
    );

    const options = {
      platform: 'darwin' as const,
      homeDir: temp,
      rootDir,
      macLabel: label,
      uid: process.getuid?.(),
      env: {
        NEXOWIRE_HUB_WS_URL: 'ws://127.0.0.1:43110/agent',
        NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME:
          'nexowire-ci-token-reference',
      },
      execPath: process.execPath,
      execArgv: [] as string[],
      cliEntrypoint: fixture,
    };

    t.after(async () => {
      try {
        await uninstallNativeAgentLifecycle(options);
      } catch {
        // Best-effort cleanup if installation failed mid-flight.
      }
      await fs.rm(temp, { recursive: true, force: true });
    });

    const installed = await installNativeAgentLifecycle(options);
    assert.equal(installed.installed, true);
    assert.equal(installed.platform, 'darwin');
    assert.equal(installed.autostart, true);
    assert.equal(installed.state, 'running');
    assert.ok((installed.pid ?? 0) > 0);

    const checked = await nativeAgentLifecycleStatus(options);
    assert.equal(checked.state, 'running');
    assert.ok((checked.pid ?? 0) > 0);

    const stopped = await stopNativeAgentLifecycle(options);
    assert.equal(stopped.installed, true);
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.pid, null);

    const started = await startNativeAgentLifecycle(options);
    assert.equal(started.state, 'running');
    assert.ok((started.pid ?? 0) > 0);

    const restarted = await restartNativeAgentLifecycle(options);
    assert.equal(restarted.state, 'running');
    assert.ok((restarted.pid ?? 0) > 0);

    const removed = await uninstallNativeAgentLifecycle(options);
    assert.equal(removed.removed, true);
    assert.equal(removed.name, label);

    const after = await nativeAgentLifecycleStatus(options);
    assert.equal(after.installed, false);
    assert.equal(after.state, 'not-installed');
  },
);
