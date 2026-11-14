import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

function browserLiveJob(): string {
  const start = ci.indexOf('\n  browser-live:\n');
  const end = ci.indexOf('\n  linux-native-live:\n', start + 1);
  assert.ok(start >= 0 && end > start, 'browser-live must remain a distinct Windows job');
  return ci.slice(start + 1, end);
}

test('hosted browser-live has a bounded job lifetime without marking timeouts successful', () => {
  const job = browserLiveJob();
  assert.match(
    job,
    /^  browser-live:\n    runs-on: windows-latest\n(?:    #[^\n]*\n)*    timeout-minutes: 75\n    steps:/,
    'the whole hosted Windows job must have a server-side duration ceiling',
  );
  assert.doesNotMatch(job, /^    continue-on-error:\s*true\s*$/m);
  assert.doesNotMatch(job, /^    if:\s*false\s*$/m);
});

test('the original DPAPI/pre-logon Hub tests keep their independent 15-minute step limit', () => {
  const job = browserLiveJob();
  const start = job.indexOf('      - name: Verify Windows DPAPI and pre-logon Hub contracts\n');
  assert.ok(start >= 0, 'DPAPI step must remain present');
  const next = job.indexOf('\n      - ', start + 1);
  assert.ok(next > start, 'DPAPI step must remain followed by other Windows checks');
  const step = job.slice(start, next);
  assert.match(step, /^        timeout-minutes: 15$/m);
  assert.match(
    step,
    /^        run: node --test --import tsx --test-concurrency=1 test\/windows-dpapi-secret\.test\.ts test\/protected-secret-files\.test\.ts test\/hub-lifecycle\.test\.ts$/m,
  );
  assert.doesNotMatch(step, /continue-on-error:\s*true|--test-skip-pattern|if:\s*false/);
});


const release = readFileSync(new URL('../.github/workflows/release-readiness.yml', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

const protectedBootGuardTests = [
  'test/hub-boot-hidden-task-visibility.test.ts',
  'test/hub-boot-install-task-absence.test.ts',
  'test/hub-boot-status-legacy-user.test.ts',
  'test/windows-unattended-reboot-readiness.test.ts',
  'test/qa-ci-browser-live-timeout.test.ts',
];

function assertProtectedBootWindowsStep(document: string, requiresWindowsCondition: boolean): void {
  const anchor = '      - name: Verify protected SYSTEM Hub task presence and no-overwrite guards\n';
  const start = document.indexOf(anchor);
  assert.ok(start >= 0, 'missing hosted protected SYSTEM task absence regressions');
  const next = document.indexOf('\n      - ', start + anchor.length);
  assert.ok(next > start, 'protected SYSTEM guard must remain a separate step');
  const step = document.slice(start, next);
  if (requiresWindowsCondition) assert.match(step, /^        if: runner.os == 'Windows'$/m);
  assert.match(step, /^        timeout-minutes: 7$/m);
  assert.match(step, /^        run: node --test --import tsx --test-concurrency=1 /m);
  for (const file of protectedBootGuardTests) {
    assert.ok(step.includes(file), 'missing protected Hub test: ' + file);
  }
  assert.doesNotMatch(step, /continue-on-error:\s*true|--test-skip-pattern|if:\s*false/);
}

test('hosted Windows CI and Release execute protected Hub task visibility guards', () => {
  assertProtectedBootWindowsStep(browserLiveJob(), false);
  assertProtectedBootWindowsStep(release, true);
});

test('other Windows native and adversarial checks remain present under the bounded job', () => {
  const job = browserLiveJob();
  for (const step of [
    'Verify recycled WAL and consecutive journal process restarts',
    'Verify update startup acknowledgement and data-preserving rollback',
    'Verify CORE console admission and local consent cancellation',
    'Compile native Windows Job guardian',
    'Physical Windows Job Object regressions',
    'Verify structured Windows controls',
    'Verify private file-picker adversarial boundaries',
    'Verify independent cross-project negative acceptance gates',
  ]) {
    assert.ok(job.includes('      - name: ' + step + '\n'), 'missing Windows check: ' + step);
  }
  assert.doesNotMatch(job, /--test-skip-pattern|continue-on-error:\s*true/);
});
