import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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

test('AI-05 Windows Plan validates a clean pinned fixture without creating a stage', {
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

  // A disposable Git repository avoids depending on unrelated generated
  // files in the real checkout or writing to the user's repository.
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'nw-ai05-plan-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(fixture, 'empty-gitconfig') };
    for (const key of Object.keys(env)) {
      if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS)$/i.test(key)) {
        delete env[key];
      }
    }
    function git(...args: string[]): string {
      const run = spawnSync('git', ['-C', fixture, ...args], {
        env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      return run.stdout.trim();
    }
    git('init', '--object-format=sha1', '-q');
    writeFileSync(path.join(fixture, 'fixture.txt'), 'AI-05 Plan fixture');
    git('add', '--', 'fixture.txt');
    git('-c', 'user.name=AI05 Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + path.join(fixture, '.git', 'disabled-hooks'),
      'commit', '-q', '-m', 'disposable Plan fixture');
    const expectedCommit = git('rev-parse', 'HEAD').toLowerCase();
    assert.match(expectedCommit, /^[a-f0-9]{40}$/);
    assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '');

    const target = path.join(documents,
      'Nexowire-SystemHub-Stage-' + randomBytes(10).toString('hex'));
    function invoke(sha: string, output: string) {
      assert.equal(existsSync(output), false);
      assert.equal(existsSync(output + '.provenance.json'), false);
      const result = spawnSync(powershell51, [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-File', script, '-Action', 'Plan',
        '-RepositoryRoot', fixture,
        '-ExpectedCommitSha', sha,
        '-OutputDirectory', output,
      ], {
        env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
        maxBuffer: 256 * 1024,
      });
      assert.equal(existsSync(output), false, 'Plan must never create a stage');
      assert.equal(existsSync(output + '.provenance.json'), false,
        'Plan must never create an acceptance receipt');
      return result;
    }
    const accepted = invoke(expectedCommit, target);
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    const receipt = JSON.parse(accepted.stdout) as {
      action: string;
      sourceClean: boolean;
      sourceCommit: string;
      readyForBuild: boolean;
      installerTargetUntouched: boolean;
      outputDirectory: string;
    };
    assert.equal(receipt.action, 'Plan');
    assert.equal(receipt.sourceClean, true);
    assert.equal(receipt.sourceCommit, expectedCommit);
    assert.equal(receipt.readyForBuild, true);
    assert.equal(receipt.installerTargetUntouched, true);
    assert.equal(path.normalize(receipt.outputDirectory).toLowerCase(), path.normalize(target).toLowerCase());

    const wrongSha = expectedCommit === '0'.repeat(40) ? '1'.repeat(40) : '0'.repeat(40);
    const wrong = invoke(wrongSha, target);
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stdout + wrong.stderr, /AI01_STAGE_SOURCE_COMMIT_MISMATCH/);

    const unsafeTarget = path.join(fixture, path.basename(target));
    const unsafe = invoke(expectedCommit, unsafeTarget);
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stdout + unsafe.stderr, /AI01_STAGE_OUTPUT_BOUNDARY_UNTRUSTED/);

    writeFileSync(path.join(fixture, 'fixture.txt'), 'modified fixture');
    const dirty = invoke(expectedCommit, target);
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stdout + dirty.stderr, /AI01_STAGE_SOURCE_WORKTREE_DIRTY/);
  } finally {
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
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
