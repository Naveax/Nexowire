import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {
  auditTwoPcTransferEvidence,
  auditS5CostEvidence,
  auditSkillSymlinkEvidence,
  auditPrInventoryFreshness,
} from '../../../scripts/delegated/k20/p007-pool-evidence-gates.mjs';

const sampleTransfer = () => ({
  sourceCommit: 'a'.repeat(40), installedSenderSha: 'a'.repeat(40),
  installedReceiverSha: 'a'.repeat(40), bytes: 268_435_457,
  fixtureSizes: [225_281, 1_048_576, 268_435_457, 1_073_741_824],
  transferMode: 'bounded-stream', chunkBytes: 65_536, maxChunksPerCall: 32,
  memoryBudgetBytes: 67_108_864, peakRssDeltaBytes: 9_000_000,
  deadlineMs: 3_600_000, transferElapsedMs: 120_000,
  freeDiskBytes: 1_500_000_000,
  senderDeviceId: 'test-sender', receiverDeviceId: 'test-receiver',
  operationId: 'operation-test', destinationPath: 'C:\\test\\large.bin',
  senderSha256: 'a'.repeat(64), receiverSha256: 'a'.repeat(64),
  receiverReadbackBytes: 268_435_457,
  ack: {operationId: 'operation-test', receiverDeviceId: 'test-receiver',
    destinationPath: 'C:\\test\\large.bin', sha256: 'a'.repeat(64), bytes: 268_435_457},
  ackLossReplayTest: 'PASS', resumeAfterReconnectTest: 'PASS',
  shaMismatchNegativeTest: 'PASS', sourceSupportsOver256MiB: true,
  sourceSupportCommit: 'a'.repeat(40), medium: 'two-real-devices',
  acceptanceApprovedByOwner: true,
});

test('D-128 source 256MiB cap blocks the existing ingest path', () => {
  const input = {...sampleTransfer(), sourceSupportsOver256MiB: false};
  const result = auditTwoPcTransferEvidence(input);
  assert.equal(result.classification, 'NOT_VERIFIED');
  assert.equal(result.sourceStillBoundedAt256MiB, true);
  assert.ok(result.missing.includes('reviewedSourceRemovalOf256MiBGate'));
});

test('D-128 exact 256MiB is not proof of an over-256MiB acceptance', () => {
  const input = {...sampleTransfer(), bytes: 268_435_456,
    receiverReadbackBytes: 268_435_456,
    ack: {...sampleTransfer().ack, bytes: 268_435_456}};
  assert.ok(auditTwoPcTransferEvidence(input).missing.includes('physicalPayloadOver256MiB'));
});

test('D-137 sender progress and matching sender digest without receiver readback is insufficient', () => {
  const input = {...sampleTransfer(), receiverSha256: undefined,
    receiverReadbackBytes: undefined};
  const result = auditTwoPcTransferEvidence(input);
  assert.ok(result.missing.includes('independentReceiverReadbackSha256'));
  assert.ok(result.missing.includes('independentReceiverReadbackBytes'));
});

test('D-137 wrong device, operation, path and ACK loss all fail closed', () => {
  const input = {...sampleTransfer(), receiverDeviceId: 'test-sender',
    ack: {...sampleTransfer().ack, operationId: 'wrong-operation'},
    ackLossReplayTest: 'NOT_RUN'};
  const result = auditTwoPcTransferEvidence(input);
  assert.ok(result.missing.includes('distinctPhysicalDevices'));
  assert.ok(result.missing.includes('scopedReceiverAck'));
  assert.ok(result.missing.includes('physicalNegativeCases'));
});

test('D-128/137 whole-file buffering, missing 1GiB case, disk pressure and timeout fail', () => {
  const input = {...sampleTransfer(), fixtureSizes: [225_281, 1_048_576, 268_435_457],
    transferMode: 'whole-file-buffer', chunkBytes: 100_000_000,
    peakRssDeltaBytes: 700_000_000, transferElapsedMs: 4_000_000,
    freeDiskBytes: 270_000_000};
  const result = auditTwoPcTransferEvidence(input);
  for (const name of ['221KiB_1MiB_256MiBPlus1_1GiBFixtures',
    'boundedChunkAndBackpressure', 'measuredMemoryBudget',
    'measuredTransferDeadline', 'diskBudgetAndSafetyMargin']) {
    assert.ok(result.missing.includes(name), name);
  }
});

test('D-137 even a structurally complete synthetic packet is never auto-PASS', () => {
  const result = auditTwoPcTransferEvidence(sampleTransfer());
  assert.equal(result.classification, 'EXTERNAL_REVIEW_REQUIRED');
  assert.deepEqual(result.missing, []);
});

const sampleCost = () => ({
  commitSha: 'f'.repeat(40), forecastClassification: 'OFFLINE_PROJECTION_NOT_PROVIDER_METER',
  zeroExtraInvoiceProven: false, providerMeterWindowHours: 24,
  providerMeterRows: 42, providerInvoiceVerified: true, currency: 'USD',
  measuredP50Ms: 20, measuredP95Ms: 90,
  fairnessAndFailureBudgetTest: 'PASS', ownerBudgetApproval: true,
});

test('D-129 a 0.00 USD projection without provider meter/invoice does not certify zero bill', () => {
  const result = auditS5CostEvidence({...sampleCost(), providerMeterRows: 0,
    providerInvoiceVerified: false});
  assert.equal(result.classification, 'COST_UNMEASURED');
  assert.equal(result.zeroExtraInvoiceProven, false);
  assert.ok(result.missing.includes('measured24hProviderMeter'));
  assert.ok(result.missing.includes('providerInvoice'));
});

test('D-129 unverified 24h/unknown p95 and unapproved budget are blockers', () => {
  const result = auditS5CostEvidence({...sampleCost(), providerMeterWindowHours: 0,
    measuredP95Ms: NaN, ownerBudgetApproval: false});
  assert.ok(result.missing.includes('measured24hProviderMeter'));
  assert.ok(result.missing.includes('measuredP50P95'));
  assert.ok(result.missing.includes('ownerBudgetApproval'));
});

test('D-129 Infinity and malformed pricing currency cannot masquerade as a measured S5 budget', () => {
  const result = auditS5CostEvidence({...sampleCost(),
    providerMeterWindowHours: Infinity, measuredP95Ms: Infinity, currency: 'US$'});
  for (const name of ['measured24hProviderMeter', 'measuredP50P95', 'rateCurrency']) {
    assert.ok(result.missing.includes(name), name);
  }
});

test('D-129 the best-shaped cost packet still requires external owner review', () => {
  assert.equal(auditS5CostEvidence(sampleCost()).classification, 'EXTERNAL_REVIEW_REQUIRED');
  assert.equal(auditS5CostEvidence(sampleCost()).zeroExtraInvoiceProven, false);
});

test('D-132 test PASS reproducing external skill-directory read is a KNOWN OPEN GAP', () => {
  assert.equal(auditSkillSymlinkEvidence({externalDirectoryReadObserved: true,
    passingTestCount: 19}).classification, 'KNOWN_OPEN_GAP');
});

test('D-132 external SKILL.md symlink is a separate OPEN gap, not a fix', () => {
  assert.equal(auditSkillSymlinkEvidence({externalManifestReadObserved: true,
    passingTestCount: 19}).classification, 'KNOWN_OPEN_GAP');
});

test('D-132 no observed escape without owner rejection/race/Windows evidence stays unverified', () => {
  const result = auditSkillSymlinkEvidence({
    externalDirectoryReadObserved: false, externalManifestReadObserved: false,
    ownerFixCommit: 'c'.repeat(40), directLoadRejectsExternalDirectory: true,
    directLoadRejectsExternalManifest: true, handleIdentityRaceTest: 'PASS',
    platformTests: {linux: 'PASS', macos: 'NOT_RUN', windows: 'NOT_RUN'},
  });
  assert.equal(result.classification, 'NOT_VERIFIED');
  assert.ok(result.missing.includes('crossPlatformFilesystemTests'));
});

const here = fileURLToPath(new URL('.', import.meta.url));
const historical = JSON.parse(readFileSync(resolve(here,
  '../../../docs/delegated/maintenance-k20/P007_59PR_LIVE_SNAPSHOT_20261108.json'), 'utf8'));
const inventory = {
  prs: historical.prs.map(p => ({number: p.number, state: p.prState,
    draft: p.draft, head: p.liveSha,
    run: {id: p.liveRun.id, head_sha: p.liveSha,
      conclusion: p.liveRun.conclusion}})),
};

test('D-136 59/59 historical rows have distinct draft PR identities', () => {
  assert.equal(inventory.prs.length, 59);
  assert.equal(new Set(inventory.prs.map(p => p.number)).size, 59);
  const old = inventory.prs.find(p => p.number === 1153);
  assert.equal(auditPrInventoryFreshness(inventory, {prNumber: 1153,
    headSha: old.head, runId: old.run.id,
    runConclusion: old.run.conclusion}).classification, 'SOURCE_INVENTORY_MATCH');
});

test('D-136 latest #1153 SHA is NOT certified by its 59-row old snapshot', () => {
  const result = auditPrInventoryFreshness(inventory, {prNumber: 1153,
    headSha: 'eb3327e0adfd0910c57daab8e4cb6051c4ff6b1c',
    runId: 42515133184, runConclusion: 'success'});
  assert.equal(result.classification, 'STALE_HEAD');
  assert.equal(result.total, 59);
});

test('D-136 stale run, missing PR and duplicate row never become current-HEAD verified', () => {
  const old = inventory.prs.find(p => p.number === 1153);
  assert.equal(auditPrInventoryFreshness(inventory, {prNumber: 1153,
    headSha: old.head, runId: 42515133184, runConclusion: 'success'}).classification,
  'STALE_OR_UNVERIFIED_RUN');
  assert.equal(auditPrInventoryFreshness(inventory, {prNumber: 9999,
    headSha: old.head}).classification, 'STALE_HEAD');
  const dup = {prs: [...inventory.prs.slice(0, -1), inventory.prs[0]]};
  assert.equal(auditPrInventoryFreshness(dup, {prNumber: 1153,
    headSha: old.head}).classification, 'INVALID_INVENTORY');
});
