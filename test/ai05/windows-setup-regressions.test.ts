import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = process.cwd();
const stagePath = path.join(root, 'scripts', 'Build-Nexowire-SystemHubStage.ps1');
const smokePath = path.join(root, 'scripts', 'smoke-windows-user-setup.ts');
const stage = readFileSync(stagePath, 'utf8');
const smoke = readFileSync(smokePath, 'utf8');

test('AI-05 SYSTEM stage honors relocated Documents and Windows directories', () => {
  assert.match(stage, /GetFolderPath\(\[Environment\+SpecialFolder\]::MyDocuments\)/);
  assert.match(stage, /GetFolderPath\(\[Environment\+SpecialFolder\]::Windows\)/);
  assert.match(stage, /AI01_STAGE_DOCUMENTS_KNOWN_FOLDER_MISSING/);
  assert.match(stage, /AI01_STAGE_OUTPUT_BOUNDARY_UNTRUSTED/);
  assert.match(stage, /AI01_STAGE_OUTPUT_ANCESTOR_REPARSE/);
  assert.match(stage, /AI01_STAGE_WINDOWS_TOOL_MISSING/);
  assert.match(stage, /AI01_STAGE_WINDOWS_REQUIRED/);
  assert.match(stage, /AI01_STAGE_64BIT_WINDOWS_REQUIRED/);
  assert.match(stage, /AI01_STAGE_64BIT_PROCESS_REQUIRED/);
  assert.match(stage, /Invoke-Checked \$tarExecutable/);
  assert.match(stage, /& \$powershell51 /);
  assert.doesNotMatch(stage, /'C:\\Windows\\System32\\(?:tar|WindowsPowerShell)/);
  assert.doesNotMatch(stage, /Register-ScheduledTask|Unregister-ScheduledTask|Stop-ScheduledTask/);
});

test('AI-05 smoke covers an installed 1.0.8 during both successful and rejected upgrades', () => {
  assert.match(smoke, /'upgrade-preserve'/);
  assert.match(smoke, /'upgrade-checksum-mismatch'/);
  assert.match(smoke, /scenario\.startsWith\('upgrade-'\)/);
  assert.match(smoke, /1\.0\.8-ai05-preserved/);
  assert.match(smoke, /previous-v1\.0\.8-binary-sentinel/);
  assert.match(smoke, /previous-v1\.0\.8-cli-sentinel/);
  assert.match(smoke, /local-identity-sentinel\.json/);
  assert.match(smoke, /preferences-sentinel\.json/);
  assert.match(smoke, /owner-sentinel\.json/);
  assert.match(smoke, /assertOldInstallIntact\(\)/);
  assert.match(smoke, /existingReleasePreserved: preserveLegacy/);
  assert.match(smoke, /preservedFixtureCount: preserveLegacy \? preservedFixtures\.size : 0/);
  assert.match(smoke, /scenario === 'install' && downloadSource === 'fixture' && runsAfter108/);
  assert.match(smoke, /for \(const upgradeScenario of \['upgrade-preserve', 'upgrade-checksum-mismatch'\]\)/);
  assert.match(smoke, /assert\.equal\(result\.scenario, upgradeScenario\)/);
  assert.match(smoke, /assert\.equal\(result\.preservedFixtureCount, 5\)/);
  assert.match(smoke, /upgradeMatrix\.push\(upgradeScenario\)/);
  assert.match(smoke, /rejectedBeforeExtraction: true/);
  assert.match(smoke, /taskRegistrationAndBrowserSimulated: true/);
  assert.match(smoke, /oauthOrDevicePairingVerified: false/);
});

test('AI-05 stage parses under native PowerShell 5.1', {
  skip: process.platform !== 'win32',
}, () => {
  const winDir = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(winDir);
  const ps = path.join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const safe = stagePath.replaceAll("'", "''");
  const result = spawnSync(ps, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('" +
      safe + "',[ref]$t,[ref]$e);if(@($e).Count -gt 0){$e|%{$_.Message};exit 5}",
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

const runLiveBundleSmoke = process.platform === 'win32' &&
  process.env.NEXOWIRE_AI05_RUN_BUNDLE_SMOKE === '1';

for (const scenario of ['upgrade-preserve', 'upgrade-checksum-mismatch']) {
  test('AI-05 disposable packaged installer: ' + scenario, {
    skip: !runLiveBundleSmoke,
  }, () => {
    const bundle = path.join(root, 'release-windows');
    for (const filename of [
      'Nexowire-Setup.cmd', 'Nexowire-Windows-x64.zip', 'SHA256SUMS-Windows',
    ]) {
      assert.ok(existsSync(path.join(bundle, filename)), 'Missing bundle fixture: ' + filename);
    }
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', smokePath, '--bundle-dir', bundle,
      '--scenario', scenario, '--profile', 'unicode', '--download-source', 'fixture',
    ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const evidence = JSON.parse(result.stdout) as {
      existingReleasePreserved: boolean;
      preservedFixtureCount: number;
      profileIsolated: boolean;
      oauthOrDevicePairingVerified: boolean;
    };
    assert.equal(evidence.existingReleasePreserved, true);
    assert.equal(evidence.preservedFixtureCount, 5);
    assert.equal(evidence.profileIsolated, true);
    assert.equal(evidence.oauthOrDevicePairingVerified, false);
  });
}
