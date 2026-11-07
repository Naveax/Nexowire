import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyPlatformEvidence, parseTapSummary } from './platform-evidence-gate.mjs';

const SHA = '4e7db16f4233048a956664bef6b607781eb63fb7';
const otherOs = process.platform === 'win32' ? 'linux' : 'win32';
const fixtures = {
  pass: `import test from 'node:test'; import assert from 'node:assert/strict';
    test('executes a real assertion', () => assert.equal(2 + 2, 4));`,
  fail: `import test from 'node:test'; import assert from 'node:assert/strict';
    test('reports a real assertion failure', () => assert.equal(2 + 2, 5));`,
  skip: `import test from 'node:test'; import assert from 'node:assert/strict';
    test('first assertion executes', () => assert.equal(2 + 2, 4));
    test('second assertion was not executed', { skip: 'another OS' }, () => assert.fail());`,
};

function runFixture(name) {
  // Node's own test subprocess exports NODE_TEST_CONTEXT. Reusing that token
  // would attach the child to the parent's test IPC instead of writing TAP.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // The deliberately FAILing fixture is generated outside the repository so
  // bare `node --test` can never auto-discover it in the project test tree.
  const temporaryDir = mkdtempSync(join(tmpdir(), 'nexowire-k02-evidence-'));
  let child;
  try {
    const path = join(temporaryDir, 'case.test.mjs');
    writeFileSync(path, fixtures[name], 'utf8');
    child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 256_000, env });
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
  assert.equal(child.error, undefined, `test process did not start: ${child.error}`);
  assert.equal(child.signal, null, 'test process was killed');
  return { exitCode: child.status, tap: child.stdout };
}

const base = {
  exactSHA: SHA, observedSHA: SHA, requiredOs: process.platform,
  runnerOs: process.platform, workflowStatus: 'completed', stepStatus: 'completed',
};

test('actual child TAP proves 1 PASS only on its observed platform', () => {
  const run = runFixture('pass');
  assert.equal(run.exitCode, 0);
  assert.equal(parseTapSummary(run.tap)?.pass, 1);
  assert.equal(classifyPlatformEvidence({ ...base, ...run }).status, 'PASS');
  assert.equal(classifyPlatformEvidence({ ...base, ...run, requiredOs: otherOs }).status, 'NOT_RUN');
});

test('actual failing child process stays FAIL even if CI overall says success', () => {
  const run = runFixture('fail');
  assert.notEqual(run.exitCode, 0);
  assert.equal(parseTapSummary(run.tap)?.fail, 1);
  assert.equal(classifyPlatformEvidence({ ...base, ...run, workflowConclusion: 'success' }).status, 'FAIL');
});

test('actual child with one skipped assertion cannot become PASS', () => {
  const run = runFixture('skip');
  assert.equal(run.exitCode, 0);
  assert.equal(parseTapSummary(run.tap)?.skipped, 1);
  assert.equal(classifyPlatformEvidence({ ...base, ...run }).status, 'PARTIAL');
});

test('real green CI jobs without a recorded assertion step are NOT_RUN', () => {
  // #1101 run #42410091949: seven hosted CI jobs succeeded, but no new K02
  // nested MJS test was explicitly named by the main CI job step list.
  const run = runFixture('pass');
  assert.equal(classifyPlatformEvidence({ ...base, ...run, stepStatus: 'not_run',
    workflowConclusion: 'success' }).status, 'NOT_RUN');
  assert.equal(classifyPlatformEvidence({ ...base, ...run, stepStatus: 'skipped' }).status, 'NOT_RUN');
});

test('wrong SHA, queued job, missing exit and missing TAP cannot be PASS', () => {
  const run = runFixture('pass');
  assert.equal(classifyPlatformEvidence({ ...base, ...run, observedSHA: '0'.repeat(40) }).status, 'UNKNOWN');
  assert.equal(classifyPlatformEvidence({ ...base, ...run, workflowStatus: 'queued' }).status, 'PENDING');
  assert.equal(classifyPlatformEvidence({ ...base, ...run, exitCode: null }).status, 'UNKNOWN');
  assert.equal(classifyPlatformEvidence({ ...base, ...run, tap: '' }).status, 'UNKNOWN');
});

test('zero test count, impossible summary and TODO are never PASS', () => {
  const summary = '# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(classifyPlatformEvidence({ ...base, exitCode: 0, tap: summary }).status, 'NOT_RUN');
  assert.equal(parseTapSummary(summary.replace('# pass 0', '# pass 1')), null);
  assert.equal(classifyPlatformEvidence({ ...base, exitCode: 0, tap: summary.replace('# pass 0', '# pass 1') }).status, 'UNKNOWN');
  assert.equal(classifyPlatformEvidence({ ...base, exitCode: 0, tap: summary.replace('# tests 0', '# tests 1').replace('# todo 0', '# todo 1') }).status, 'PARTIAL');
});

test('a workflow marked complete without a completed assertion is UNKNOWN', () => {
  const run = runFixture('pass');
  assert.equal(classifyPlatformEvidence({ ...base, ...run, stepStatus: undefined }).status, 'UNKNOWN');
  assert.equal(classifyPlatformEvidence({ ...base, ...run, runnerOs: 'untrusted' }).status, 'UNKNOWN');
});
