import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditAcceptance, providerCostGate, transferCaseGate, largeTransferGate } from './p009-acceptance-evidence-gates.mjs';

const fixturePath=fileURLToPath(new URL('../../../docs/delegated/integration-k14/p009-acceptance-template-20261109.json',import.meta.url));
const fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
const clone=()=>structuredClone(fixture);
const digest='abc123'.repeat(10)+'abcd';
const now={start:'2026-11-08T00:00:00Z',end:'2026-11-09T01:00:00Z'};

function completeS5() {
  const s=clone().s5;
  Object.assign(s,{ownerApprovalRef:'approval-in-owner-ticket',runType:'actual_hosted_provider',
    environment:'staging',providerName:'Example Provider',providerAccountScope:'staging-account',
    measurementWindow:now,
    metrics:{usersPerDay:10,hostedIngressCalls:500,cpuMilliseconds:5000,d1Reads:700,
      d1Writes:100,relayBytes:250000,reconnects:4,failedCalls:0,p50Milliseconds:25,p95Milliseconds:38,
      billingPausedProbe:{executed:true,denialProven:true},quotaExhaustionProbe:{executed:true,denialProven:true}},
    forecasts:[100,1000,10000].map(users=>({users,basedOnMeasuredWindow:true,projectedProviderCostUsd:users*0.25})),
    providerInvoice:{kind:'provider_actual',documentRef:'provider-statement-id',currency:'USD',amountMinorUnits:0,period:now}});
  return s;
}
function goodCase(sizeBytes) {
  return {sizeBytes,testDeviceAuthorizationRef:'owner-approved-device-test',senderDeviceId:'sender',receiverDeviceId:'receiver',
    sessionId:'session-001',destinationPath:'device-root/demo.bin',transferredBytes:sizeBytes,receiverStoredBytes:sizeBytes,
    senderDigest:digest,independentReceiverReadbackDigest:digest,
    ack:{acknowledged:true,sessionId:'session-001',deviceId:'receiver',destinationPath:'device-root/demo.bin',receiverDigest:digest},
    transferWindow:now,senderArtifactRef:'proof/sender-digest',receiverArtifactRef:'proof/receiver-readback',
    peakProcessRssBytes:55000000,maxRequestChunkBytes:65536,approvedChunkLimitBytes:131072,chunkPolicyRef:'owner-configured-stream-budget'};
}
function completeTransfer() {
  const x=clone().transfer;
  x.runType='authorized_physical_two_pc';
  x.cases=[226304,1048576,268435457,1073741824].map(goodCase);
  x.negativeCases=['ACK_LOST','OFFSET_DRIFT','SOURCE_REPLACED','CORRUPT_CHUNK','DISK_FULL'].map(scenario=>({scenario,deniedSafely:true,artifactRef:'negative-case-proof'}));
  return x;
}

test('no provider or two-PC evidence remains explicitly NOT_RUN, not zero cost',()=>{
  const r=auditAcceptance(fixture);
  assert.equal(r.productionAccepted,false);
  assert.equal(r.physicalAcceptance,'NOT_RUN_OR_NOT_INDEPENDENTLY_VERIFIED');
  assert.equal(r.s5.actualProviderCostUsd,'UNKNOWN_OR_NOT_RUN');
  assert.equal(r.transfer.physicalAccepted,false);
  assert.ok(r.s5.blockingReasons.length>0&&r.transfer.blockingReasons.length>0);
});

test('offline numeric cost forecast cannot replace provider invoice or a real 24h run',()=>{
  const s=completeS5();s.runType='synthetic_local';s.providerInvoice.kind='synthetic_quote';
  const r=providerCostGate(s);
  assert.ok(r.blockingReasons.includes('NO_24H_HOSTED_MEASUREMENT'));
  assert.ok(r.blockingReasons.includes('REAL_PROVIDER_INVOICE_UNVERIFIED'));
  assert.equal(r.actualProviderCostUsd,'UNKNOWN_OR_NOT_RUN');
});

test('self-reported complete S5 fields still require independent owner/provider authentication',()=>{
  const r=providerCostGate(completeS5());
  assert.deepEqual(r.blockingReasons,[]);
  assert.equal(r.evidenceStage,'EVIDENCE_FIELDS_PRESENT_PENDING_AUTHENTICITY_AND_OWNER_REVIEW');
  assert.deepEqual(r.claimedInvoiceUnverified,{currency:'USD',minorUnits:0});
  assert.equal(r.actualProviderCostUsd,'UNKNOWN_OR_NOT_RUN');
  assert.equal(r.productionAccepted,false);
});

test('a single-minute localhost sample is not 24h hosted acceptance',()=>{
  const s=completeS5();s.measurementWindow={start:'2026-11-08T00:00:00Z',end:'2026-11-08T00:01:00Z'};
  assert.ok(providerCostGate(s).blockingReasons.includes('NO_24H_HOSTED_MEASUREMENT'));
});

test('all 100/1000/10000 forecasts require a measured provenance marker',()=>{
  const s=completeS5();s.forecasts[1].basedOnMeasuredWindow=false;
  assert.ok(providerCostGate(s).blockingReasons.includes('MEASURED_BASED_CAPACITY_FORECAST_INCOMPLETE'));
});

test('negative, NaN or Infinity metrics never pass as real metering',()=>{
  for(const v of [-1,NaN,Infinity,'UNKNOWN']){
    const s=completeS5();s.metrics.hostedIngressCalls=v;
    assert.ok(providerCostGate(s).blockingReasons.includes('REAL_METER_OR_LATENCY_MISSING'));
  }
});

test('p95 smaller than p50 does not satisfy a believable latency envelope',()=>{
  const s=completeS5();s.metrics.p95Milliseconds=10;
  assert.ok(providerCostGate(s).blockingReasons.includes('REAL_METER_OR_LATENCY_MISSING'));
});

test('billing-paused or quota exhaustion denial missing leaves issue #487 acceptance open',()=>{
  const s=completeS5();s.metrics.quotaExhaustionProbe.denialProven=false;
  assert.ok(providerCostGate(s).blockingReasons.includes('QUOTA_BILLING_DENIAL_NOT_PROVEN'));
});

test('actual file digest and independent receiver readback still need session-bound ACK',()=>{
  const c=goodCase(1048576);c.ack.acknowledged=false;
  const r=transferCaseGate(c);
  assert.ok(r.blockingReasons.includes('RECEIVER_ACK_MISSING_OR_UNBOUND'));
  assert.equal(r.physicalAccepted,false);
});

test('ACK from wrong device/path/session is not proof of receiver apply',()=>{
  for(const k of ['deviceId','destinationPath','sessionId']){
    const c=goodCase(226304);c.ack[k]='different';
    assert.ok(transferCaseGate(c).blockingReasons.includes('RECEIVER_ACK_MISSING_OR_UNBOUND'));
  }
});

test('same-device sender-receiver or missing owner authorization cannot certify two-PC',()=>{
  const c=goodCase(226304);c.receiverDeviceId=c.senderDeviceId;c.testDeviceAuthorizationRef='';
  assert.ok(transferCaseGate(c).blockingReasons.includes('TWO_AUTHORIZED_DISTINCT_DEVICES_UNPROVEN'));
});

test('sender-only hash and 100% progress cannot substitute receiver digest and byte count',()=>{
  const c=goodCase(1048576);c.receiverStoredBytes=1048575;c.independentReceiverReadbackDigest='f'.repeat(64);
  const r=transferCaseGate(c);
  assert.ok(r.blockingReasons.includes('BYTE_COUNTS_UNVERIFIED'));
  assert.ok(r.blockingReasons.includes('INDEPENDENT_RECEIVER_DIGEST_MISSING_OR_DIFFERENT'));
});

test('chunk limit is owner-configured, not a new fixed 64KiB global restriction',()=>{
  const c=goodCase(1048576);c.maxRequestChunkBytes=131072;
  assert.ok(!transferCaseGate(c).blockingReasons.includes('BOUNDED_STREAMING_MEMORY_UNPROVEN'));
  c.maxRequestChunkBytes=131073;
  assert.ok(transferCaseGate(c).blockingReasons.includes('BOUNDED_STREAMING_MEMORY_UNPROVEN'));
});

test('four size tiers and failure/resume scenarios must have durable physical proof',()=>{
  const t=completeTransfer();t.cases=t.cases.filter(c=>c.sizeBytes!==268435457);
  t.negativeCases=t.negativeCases.filter(c=>c.scenario!=='ACK_LOST');
  const r=largeTransferGate(t);
  assert.ok(r.blockingReasons.includes('SIZE_268435457_ACCEPTANCE_MISSING'));
  assert.ok(r.blockingReasons.includes('FAILURE_AND_RESUME_CASES_INCOMPLETE'));
});

test('even complete synthetic physical fields only permit owner/independent review',()=>{
  const r=largeTransferGate(completeTransfer());
  assert.deepEqual(r.blockingReasons,[]);
  assert.equal(r.evidenceStage,'FIELDS_PRESENT_PENDING_OWNER_REVIEW');
  assert.equal(r.physicalAccepted,false);
  assert.equal(r.ownerReviewRequired,true);
});

test('invalid or tampered schema must fail closed',()=>{
  assert.throws(()=>auditAcceptance({...fixture,schemaVersion:2}),/Unknown evidence schema/);
  assert.throws(()=>auditAcceptance(null),/Unknown evidence schema/);
});
