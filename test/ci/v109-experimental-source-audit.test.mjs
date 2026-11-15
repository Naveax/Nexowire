import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPERIMENTAL_TAG,
  EXPERIMENTAL_VERSION,
  REQUIRED_SOURCE_FILES,
  CORE_PHYSICAL_GATES,
  assessExperimentalSource,
  inspectExperimentalSource,
} from '../../scripts/ci/v109-experimental-source-audit.mjs';

const sourceSha = 'a'.repeat(40);
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
  assert.equal(result.publicReleasePublished, false);
  assert.equal(result.fullCoreAccessVerified, false);
  assert.equal(result.physicalCoreStatus, 'NOT_ATTESTED');
  assert.equal(result.physicalAcceptance, 'NOT_RUN');
  assert.equal(result.trackedTypeScriptTests, 635);
  assert.equal(result.approvedPortableTestFiles, 29);
  assert.equal(result.notRunInPortableLane, 606);
  assert.deepEqual(result.physicalCoreRequirements, [...CORE_PHYSICAL_GATES]);
  assert.ok(Object.values(result.sourceCapabilityInventory).every(
    item => item.sourceFound === true && item.runtimeAccepted === false,
  ));
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
  assert.equal(report.fullCoreAccessVerified, false);
});
