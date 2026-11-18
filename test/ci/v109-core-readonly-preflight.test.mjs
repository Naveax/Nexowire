import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = readFileSync(
  path.join(root, 'scripts/Read-Nexowire-V109CoreReadiness.ps1'), 'utf8',
);

test('physical CORE observer uses read-only scheduled-task and loopback queries', () => {
  assert.match(script, /Get-ScheduledTask -TaskName/);
  assert.match(script, /Get-ScheduledTaskInfo/);
  assert.match(script, /Get-NetTCPConnection/);
  for (const forbidden of [
    /\bRegister-ScheduledTask\b/i, /\bUnregister-ScheduledTask\b/i,
    /\bSet-ScheduledTask\b/i, /\bStart-ScheduledTask\b/i,
    /\bStop-ScheduledTask\b/i, /\bSet-Acl\b/i,
    /\bRemove-Item\b/i, /\bRestart-Computer\b/i,
    /\bStart-Process\b/i, /\bInvoke-RestMethod\b/i,
    /\breadExistingPrivilegedBrokerToken\b/i,
  ]) assert.doesNotMatch(script, forbidden);
});

test('Task Scheduler status is rendered as an unsigned eight-digit HRESULT without authority claims', {
  skip: process.platform !== 'win32',
}, () => {
  const fn = /^function ConvertTo-TaskResultHex \{[\s\S]*?^\}/m.exec(script)?.[0];
  assert.ok(fn, 'missing status formatter function');
  const run = spawnSync('powershell.exe', [
    '-NoProfile','-NonInteractive','-Command',
    fn+'\n2147946720,267009,-1,0 | ForEach-Object { ConvertTo-TaskResultHex -Result $_ }',
  ], {encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(run.status,0,run.stderr || run.error?.message);
  assert.deepEqual(run.stdout.trim().split(/\r?\n/),[
    '0x800710E0','0x00041301','0xFFFFFFFF','0x00000000',
  ]);
  assert.match(script,/Running and a loopback listener do not attest elevated CORE effect admission/);
});

test('disk reserve probes are read-only advisory results, not a migration approval', () => {
  assert.match(script, /function Read-DiskReserve/);
  assert.match(script, /AvailableFreeSpace/);
  assert.match(script, /Read-DiskReserve -Path \$env:ProgramData/);
  assert.match(script, /Read-DiskReserve -Path \$env:USERPROFILE/);
  assert.match(script, /recommendedReserveMet = \$null/);
  assert.match(script, /advisoryOnly = \$true/);
  assert.doesNotMatch(script, /\bClear-RecycleBin\b|\bRemove-Item\b|\bSet-Acl\b/i);
});

test('Windows preflight reports actual drive bytes without claiming physical SYSTEM acceptance', {
  skip: process.platform !== 'win32',
}, () => {
  const run = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File',
    path.join(root, 'scripts/Read-Nexowire-V109CoreReadiness.ps1'), '-Json',
  ], {encoding: 'utf8', timeout: 30000, windowsHide: true});
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const report = JSON.parse(run.stdout);
  assert.equal(report.fullCoreAccessVerified, false);
  assert.equal(report.trustedSystemHubAcceptance, 'NOT_RUN');
  for (const task of report.tasks) {
    if (task.visibility === 'VISIBLE') {
      assert.equal(task.lastResultHex, '0x' +
        (task.lastResult >>> 0).toString(16).toUpperCase().padStart(8,'0'));
    } else {
      assert.equal(task.lastResult, null);
      assert.equal(task.lastResultHex, null);
    }
  }
  for (const result of [
    report.diskReserve.systemStateVolume, report.diskReserve.userStateVolume,
  ]) {
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.recommendedReserveGiB, 8);
    if (result.evidence === 'UNKNOWN') {
      assert.equal(result.availableGiB, null);
      assert.equal(result.recommendedReserveMet, null);
    } else {
      assert.equal(result.evidence, 'READ_ONLY_AVAILABLE_FREE_SPACE');
      assert.ok(result.availableGiB >= 0);
      assert.equal(typeof result.recommendedReserveMet, 'boolean');
      assert.ok(result.root?.length > 0);
    }
  }
});

test('missing disk environment produces UNKNOWN, never a false reserve PASS', {
  skip: process.platform !== 'win32',
}, () => {
  const run = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File',
    path.join(root, 'scripts/Read-Nexowire-V109CoreReadiness.ps1'), '-Json',
  ], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: {...process.env, ProgramData: '', USERPROFILE: ''},
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const report = JSON.parse(run.stdout);
  for (const record of [
    report.diskReserve.systemStateVolume, report.diskReserve.userStateVolume,
  ]) {
    assert.equal(record.evidence, 'UNKNOWN');
    assert.equal(record.availableGiB, null);
    assert.equal(record.recommendedReserveMet, null);
    assert.equal(record.advisoryOnly, true);
  }
  assert.equal(report.fullCoreAccessVerified, false);
});

test('read-only preflight never mistakes a running task for CORE verification', () => {
  assert.match(script, /fullCoreAccessVerified = \$false/);
  assert.match(script, /brokerAuthenticatedEffectAcceptance = 'NOT_RUN'/);
  assert.match(script, /protectedSqliteAndDpapiAcceptance = 'NOT_RUN'/);
  assert.match(script, /revocationAndNoReplayAcceptance = 'NOT_RUN'/);
});
