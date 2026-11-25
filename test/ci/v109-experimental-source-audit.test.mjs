import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  EXPERIMENTAL_TAG,
  EXPERIMENTAL_VERSION,
  REQUIRED_SOURCE_FILES,
  CORE_PHYSICAL_GATES,
  assessExperimentalSource,
  inspectExperimentalSource,
} from '../../scripts/ci/v109-experimental-source-audit.mjs';

const sourceSha = 'a'.repeat(40);

test('release readiness enforces preview source audit by package version, not PR branch name', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release-readiness.yml', import.meta.url), 'utf8');
  const start = workflow.indexOf('- name: Verify experimental source and deny fake CORE acceptance');
  assert.ok(start >= 0, 'experimental source audit workflow step is required');
  const end = workflow.indexOf('      - name:', start + 9);
  const step = workflow.slice(start, end < 0 ? undefined : end);
  assert.match(step, /if: github\.event_name == 'pull_request'/);
  assert.match(step, /version=.*node -p/);
  assert.match(step, /1\.0\.9-exp\.0/);
  assert.match(step, /v109-experimental-source-audit\.test\.mjs/);
  assert.match(step, /v109-core-readonly-preflight\.test\.mjs/);
  assert.match(step, /Unknown experimental candidate/);
  assert.doesNotMatch(step, /startsWith\(github\.head_ref/,
    'The audit must remain enabled after a preview is integrated into a differently named PR branch');
});
const allFiles = Object.values(REQUIRED_SOURCE_FILES);
const input = () => ({
  version: EXPERIMENTAL_VERSION,
  lockVersion: EXPERIMENTAL_VERSION,
  rootLockVersion: EXPERIMENTAL_VERSION,
  sourceSha,
  presentFiles: allFiles,
});

test('experimental package and exact source inventory are recognized without claiming physical CORE', () => {
  const result = assessExperimentalSource(input());
  assert.equal(result.sourceReady, true);
  assert.equal(result.release, EXPERIMENTAL_TAG);
  assert.equal(result.channel, 'EXPERIMENTAL_PREVIEW');
  assert.equal(result.stablePublishAuthorized, false);
  assert.equal(result.publicReleasePublished, null);
  assert.equal(result.publicationEvidence, 'NOT_CHECKED_SOURCE_ONLY');
  assert.equal(result.fullCoreAccessVerified, false);
  assert.equal(result.physicalCoreStatus, 'NOT_ATTESTED');
  assert.equal(result.physicalAcceptance, 'NOT_RUN');
  assert.equal(result.trackedTypeScriptTests, null);
  assert.equal(result.testInventoryEvidence, 'NOT_CHECKED_SOURCE_ONLY');
  assert.equal(result.approvedPortableTestFiles, null);
  assert.equal(result.notRunInPortableLane, null);
  assert.deepEqual(result.historicalPortableLane, {
    sourceSha: 'af6a83b8474500b48fe663129f5f1df2beb63e3e',
    trackedTypeScriptTests: 635,
    approvedPortableTestFiles: 29,
    notRunInPortableLane: 606,
  });
  assert.deepEqual(result.physicalCoreRequirements, [...CORE_PHYSICAL_GATES]);
  assert.ok(Object.values(result.sourceCapabilityInventory).every(
    item => item.sourceFound === true && item.runtimeAccepted === false,
  ));
});

test('release notes identify historical portable-lane counts instead of pretending current full TS coverage', () => {
  const doc = readFileSync(new URL('../../docs/releases/v1.0.9-experimental.md', import.meta.url), 'utf8');
  assert.match(doc, /historical source base/);
  assert.match(doc, /635\/29\/606 figures describe only the/);
  assert.match(doc, /not proven never to have run in another workflow/);
  assert.match(doc, /exact-source execution receipt and coverage reconciliation/);
  assert.match(doc, /moving #1160 head/);
  assert.doesNotMatch(doc, /All 606 other tracked TS test files are still NOT_RUN/);
});

test('a caller-supplied count is not an immutable-source or execution receipt', () => {
  const result = assessExperimentalSource({...input(), trackedTypeScriptTests: 649});
  assert.equal(result.trackedTypeScriptTests, 649);
  assert.equal(result.testInventoryEvidence, 'CALLER_SUPPLIED_COUNT_NOT_EXECUTION');
  assert.equal(result.approvedPortableTestFiles, null);
  assert.equal(result.notRunInPortableLane, null);
  assert.equal(assessExperimentalSource({...input(), trackedTypeScriptTests: -1}).trackedTypeScriptTests, null);
});

test('release audit rejects modified or staged TypeScript tests under an unchanged HEAD SHA', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nx-v109-source-inventory-'));
  const call = (...args) => execFileSync('git', args, {
    cwd:dir, encoding:'utf8', timeout:12000, windowsHide:true,
  });
  const testFile = path.join(dir,'test','fixture.test.ts');
  try {
    mkdirSync(path.join(dir,'test'));
    writeFileSync(path.join(dir,'package.json'), JSON.stringify({version:EXPERIMENTAL_VERSION}));
    writeFileSync(path.join(dir,'package-lock.json'), JSON.stringify({
      version:EXPERIMENTAL_VERSION, packages:{'':{version:EXPERIMENTAL_VERSION}},
    }));
    writeFileSync(testFile, 'export const n = 1;\n');
    call('init','-q');
    call('add','--','package.json','package-lock.json','test/fixture.test.ts');
    call('-c','user.name=Nexowire CI','-c','user.email=ci@example.invalid',
      'commit','-qm','create synthetic source');
    const committed = inspectExperimentalSource(dir);
    assert.equal(committed.trackedTypeScriptTests,1);
    assert.equal(committed.testInventoryEvidence,'GIT_HEAD_TREE_RECONCILED_NOT_EXECUTION');
    assert.equal(committed.sourceSha,call('rev-parse','HEAD').trim());
    writeFileSync(testFile, 'export const n = 2;\n');
    assert.throws(()=>inspectExperimentalSource(dir),
      /TEST_INVENTORY_TRACKED_TEST_WORKTREE_DIRTY/);
    call('add','--','test/fixture.test.ts');
    assert.throws(()=>inspectExperimentalSource(dir),
      /TEST_INVENTORY_INDEX_HEAD_TREE_MISMATCH/);
  } finally {
    rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

test('missing package/lock version agreement blocks the candidate', () => {
  for (const patch of [
    { version: '1.0.9' },
    { version: '1.0.8' },
    { lockVersion: '1.0.8' },
    { rootLockVersion: '1.0.8' },
  ]) {
    assert.equal(assessExperimentalSource({ ...input(), ...patch }).sourceReady, false);
  }
});

test('invalid source commit and missing critical capabilities block source claim', () => {
  for (const sourceSha of ['', 'unknown', 'F'.repeat(40)]) {
    assert.equal(assessExperimentalSource({ ...input(), sourceSha }).sourceReady, false);
  }
  const reduced = allFiles.filter(file => file !== REQUIRED_SOURCE_FILES.coreAdmission);
  const result = assessExperimentalSource({ ...input(), presentFiles: reduced });
  assert.equal(result.sourceReady, false);
  assert.deepEqual(result.missingSources, ['coreAdmission']);
});

test('source-only proof never becomes a Windows identity, UAC or Broker authority proof', () => {
  const result = assessExperimentalSource({
    ...input(),
    ownerConsent: true, elevated: true, brokerRunning: true,
    machineDpapiVerified: true, rebootPass: true, coreClaimed: true,
  });
  assert.equal(result.fullCoreAccessVerified, false);
  assert.equal(result.physicalCoreStatus, 'NOT_ATTESTED');
  assert.equal(result.stablePublishAuthorized, false);
});

test('read-only repository inspection produces a valid local source-only report', () => {
  const report = inspectExperimentalSource(process.cwd());
  assert.equal(report.packageVersion, EXPERIMENTAL_VERSION);
  assert.equal(report.sourceReady, true);
  const tracked = execFileSync('git',
    ['ls-files', '-z', '--', 'test/**/*.test.ts', 'test/*.test.ts'], {
      cwd: process.cwd(), encoding: 'utf8',
    }).split('\0').filter(file => file.endsWith('.test.ts'));
  assert.equal(report.trackedTypeScriptTests, new Set(tracked).size);
  assert.equal(report.testInventoryEvidence, 'GIT_HEAD_TREE_RECONCILED_NOT_EXECUTION');
  assert.equal(report.approvedPortableTestFiles, null);
  assert.equal(report.notRunInPortableLane, null);
  assert.equal(report.fullCoreAccessVerified, false);
});
