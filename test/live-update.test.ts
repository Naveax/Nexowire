import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  checkLiveUpdate,
  compareReleaseVersions,
  parseWindowsChecksumFile,
  parseWindowsSetupMetadata,
  readLiveUpdateState,
  renderWindowsCutoverScript,
} from '../src/update/live-update.js';

test('live updater compares stable release versions numerically', () => {
  assert.equal(compareReleaseVersions('1.0.3', '1.0.3'), 0);
  assert.equal(compareReleaseVersions('1.0.3', '1.0.4'), -1);
  assert.equal(compareReleaseVersions('1.10.0', '1.9.9'), 1);
  assert.throws(
    () => compareReleaseVersions('1.0.3-beta', '1.0.4'),
    /Unsupported Nexowire release version/,
  );
});

test('live updater requires exact Windows checksum records', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const parsed = parseWindowsChecksumFile(
    a + '  Nexowire-Windows-x64.zip\n' +
    b + '  Nexowire-Setup.cmd\n',
  );
  assert.equal(parsed.get('Nexowire-Windows-x64.zip'), a);
  assert.equal(parsed.get('Nexowire-Setup.cmd'), b);
  assert.throws(
    () => parseWindowsChecksumFile('not-a-checksum'),
    /Invalid Windows checksum line/,
  );
});

test('live updater accepts only version-bound Windows setup metadata', () => {
  assert.deepEqual(
    parseWindowsSetupMetadata(
      '@echo off\r\n' +
      'set "NX_VERSION=1.2.3"\r\n' +
      'set "NX_BUILD_ID=1.2.3-012345abcdef"\r\n',
    ),
    {
      version: '1.2.3',
      buildId: '1.2.3-012345abcdef',
    },
  );
  assert.throws(
    () => parseWindowsSetupMetadata(
      'set "NX_VERSION=1.2.3"\n' +
      'set "NX_BUILD_ID=other-build"\n',
    ),
    /build ID is invalid/,
  );
});

test('live update check persists official release state without applying it', async () => {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-live-update-test-'),
  );
  try {
    const result = await checkLiveUpdate({
      localAppData: temp,
      fetchImpl: async (input) => {
        assert.equal(
          String(input),
          'https://api.github.com/repos/Naveax/Nexowire/releases/latest',
        );
        return Response.json({
          tag_name: 'v9.9.9',
          html_url:
            'https://github.com/Naveax/Nexowire/releases/tag/v9.9.9',
          published_at: '2026-10-07T00:00:00Z',
        });
      },
    });
    assert.equal(result.latestVersion, '9.9.9');
    assert.equal(result.updateAvailable, true);

    const state = await readLiveUpdateState({
      localAppData: temp,
    });
    assert.equal(state.state, 'idle');
    assert.equal(state.targetVersion, '9.9.9');
    assert.equal(state.error, null);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Windows live cutover is side-by-side, health checked and rollback capable', () => {
  const script = renderWindowsCutoverScript({
    targetVersion: '1.0.4',
    buildId: '1.0.4-012345abcdef',
    targetRoot:
      'C:\\Users\\test\\AppData\\Local\\Nexowire\\versions\\1.0.4-012345abcdef',
    localAppData: 'C:\\Users\\test\\AppData\\Local',
  });

  assert.match(script, /Nexowire Native Agent/);
  assert.match(script, /Nexowire Hub/);
  assert.match(script, /Updated Hub did not become healthy/);
  assert.match(script, /Updated Agent did not start from the new runtime/);
  assert.match(script, /Restore-Launchers/);
  assert.match(script, /rolled_back/);
  assert.match(script, /Nexowire Hub Boot/);
  assert.match(script, /Nexowire Privileged Broker/);
  assert.match(script, /machineComponentsPending/);
  assert.doesNotMatch(script, /Remove-Item.+versions.+Recurse/i);
});


test('automatic update requires elevated Broker and skips absent/unreachable authority', async () => {
  const { executeAutomaticUpdate } = await import('../src/update/auto-update.js');
  const release = {
    currentVersion: '1.0.5',
    latestVersion: '1.0.6',
    updateAvailable: true,
    release: {
      version: '1.0.6',
      tag: 'v1.0.6',
      htmlUrl: 'https://github.com/Naveax/Nexowire/releases/tag/v1.0.6',
      publishedAt: '2026-10-08T00:00:00Z',
    },
  };
  let calls = 0;
  const absent = await executeAutomaticUpdate({
    check: async () => release,
    broker: async () => null,
    apply: async () => { calls++; return { scheduled: true }; },
  });
  assert.equal(absent.action, 'broker_unavailable');
  assert.equal(calls, 0);

  const offline = await executeAutomaticUpdate({
    check: async () => release,
    broker: async () => ({
      probe: async () => ({ reachable: false, elevated: false, version: '1.0.5' }),
    }) as never,
    apply: async () => { calls++; return { scheduled: true }; },
  });
  assert.equal(offline.action, 'broker_unavailable');
  assert.equal(calls, 0);

  const healthy = await executeAutomaticUpdate({
    check: async () => release,
    broker: async () => ({
      probe: async () => ({ reachable: true, elevated: true, version: '1.0.5' }),
    }) as never,
    apply: async () => { calls++; return { scheduled: true }; },
  });
  assert.equal(healthy.action, 'update_scheduled');
  assert.equal(calls, 1);
});

test('automatic update skips already-current releases without Broker or writes', async () => {
  const { executeAutomaticUpdate } = await import('../src/update/auto-update.js');
  const result = await executeAutomaticUpdate({
    check: async () => ({
      currentVersion: '1.0.5',
      latestVersion: '1.0.5',
      updateAvailable: false,
      release: { version: '1.0.5', tag: 'v1.0.5', htmlUrl: '', publishedAt: null },
    }),
    broker: async () => { throw new Error('should not request broker'); },
    apply: async () => { throw new Error('should not apply'); },
  });
  assert.equal(result.action, 'up_to_date');
});

test('automatic Windows task is hourly, indefinite, user-limited and singleton', async () => {
  const {
    AUTO_UPDATE_INTERVAL_MINUTES,
    renderAutoUpdateTaskInstallScript,
    renderAutoUpdateLauncher,
  } = await import('../src/update/auto-update.js');
  assert.equal(AUTO_UPDATE_INTERVAL_MINUTES, 60);
  const script = renderAutoUpdateTaskInstallScript('C:\\Users\\test\\.nexowire\\auto-update\\launch.ps1');
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(script, /New-ScheduledTaskTrigger -Once/);
  assert.match(script, /-RepetitionInterval \(New-TimeSpan -Minutes 60\)/);
  assert.match(script, /\$hour\.Repetition\.Duration=\$null/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.match(script, /-RunLevel Limited/);
  assert.match(script, /Start-ScheduledTask/);
  assert.doesNotMatch(script, /ServiceAccount|RunLevel Highest|RunLevel SYSTEM/i);
  const launcher = renderAutoUpdateLauncher('C:\\Runtime\\node.exe', 'C:\\Runtime\\cli.js');
  assert.match(launcher, /'update' 'auto' 'run'/);
  assert.doesNotMatch(launcher, /password|authorization|Bearer/i);
});

test('automatic strict Broker requirement is opt-in and preserves old manual behavior', async () => {
  const { executeAutomaticUpdate } = await import('../src/update/auto-update.js');
  // A rejected official machine update must propagate rather than marking a
  // partially-installed runtime as a successful automatic rollout.
  await assert.rejects(
    () => executeAutomaticUpdate({
      check: async () => ({
        currentVersion: '1.0.5', latestVersion: '1.0.6', updateAvailable: true,
        release: { version: '1.0.6', tag: 'v1.0.6', htmlUrl: '', publishedAt: null },
      }),
      broker: async () => ({
        probe: async () => ({ reachable: true, elevated: true, version: '1.0.5' }),
      }) as never,
      apply: async () => { throw new Error('MACHINE_UPDATE_FAILED'); },
    }),
    /MACHINE_UPDATE_FAILED/,
  );
});


test('Windows update patches only the versioned runtime root and also updates the hourly launcher', () => {
  const script = renderWindowsCutoverScript({
    targetVersion: '1.0.6',
    buildId: '1.0.6-012345abcdef',
    targetRoot:
      'C:\\Users\\test\\AppData\\Local\\Nexowire\\versions\\1.0.6-012345abcdef',
    localAppData: 'C:\\Users\\test\\AppData\\Local',
  });
  assert.match(script, /AutoLauncher/);
  assert.match(script, /Patch-Launcher \$AutoLauncher/);
  assert.match(script, /\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-\[a-f0-9\]\{12\}/);
  assert.doesNotMatch(script, /versions\\\[\^''/);
});
