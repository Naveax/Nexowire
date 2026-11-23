import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const windows = process.platform === 'win32';
const script = path.join(process.cwd(), 'scripts', 'Build-Nexowire-SystemHubStage.ps1');
const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? '';
const powershell51 = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function runPs(executable: string, scriptText: string) {
  return spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', scriptText], {
    cwd: process.cwd(),
    windowsHide: true,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 128 * 1024,
  });
}

function literal(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}

test('AI-05 Windows Plan honors the shell known Documents folder without creating a stage', {
  skip: !windows,
}, (t) => {
  assert.ok(existsSync(powershell51), 'Windows PowerShell 5.1 must exist on Windows 10/11');
  const query = runPs(powershell51,
    '[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(' +
    '[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)))');
  assert.equal(query.status, 0, query.stdout + query.stderr);
  const documents = Buffer.from(query.stdout.trim(), 'base64').toString('utf16le');
  if (!documents || !existsSync(documents)) {
    t.skip('Known Documents location is not provisioned in this ephemeral runner profile');
    return;
  }

  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(commit.status, 0, commit.stderr);
  const expectedCommit = commit.stdout.trim();
  assert.match(expectedCommit, /^[a-f0-9]{40}$/i);

  const target = path.join(documents,
    'Nexowire-SystemHub-Stage-' + randomBytes(10).toString('hex'));
  assert.equal(existsSync(target), false);
  const invoke = spawnSync(powershell51, [
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-File', script, '-Action', 'Plan',
    '-RepositoryRoot', process.cwd(),
    '-ExpectedCommitSha', expectedCommit,
    '-OutputDirectory', target,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });
  assert.equal(invoke.status, 0, invoke.stdout + invoke.stderr);
  const receipt = JSON.parse(invoke.stdout) as {
    action: string;
    sourceClean: boolean;
    sourceCommit: string;
    readyForBuild: boolean;
    installerTargetUntouched: boolean;
    outputDirectory: string;
  };
  assert.equal(receipt.action, 'Plan');
  assert.equal(receipt.sourceClean, true);
  assert.equal(receipt.sourceCommit, expectedCommit.toLowerCase());
  assert.equal(receipt.readyForBuild, true);
  assert.equal(receipt.installerTargetUntouched, true);
  assert.equal(path.normalize(receipt.outputDirectory).toLowerCase(), path.normalize(target).toLowerCase());
  assert.equal(existsSync(target), false, 'Plan must never create a staging directory');
  assert.equal(existsSync(target + '.provenance.json'), false,
    'Plan must never create an acceptance receipt');
});

test('AI-05 SYSTEM staging parses on PowerShell 7 when available', {
  skip: !windows,
}, (t) => {
  const version = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  if (version.error && (version.error as NodeJS.ErrnoException).code === 'ENOENT') {
    t.skip('PowerShell 7 not present on the runner');
    return;
  }
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^7(?:\s|$)/);
  const parser = [
    '$tokens=$null;$errors=$null',
    '[void][System.Management.Automation.Language.Parser]::ParseFile(' +
      literal(script) + ',[ref]$tokens,[ref]$errors)',
    'if(@($errors).Count -gt 0){$errors|ForEach-Object{$_.Message};exit 5}',
  ].join(';');
  const result = runPs('pwsh', parser);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
