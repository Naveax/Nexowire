import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateS5AuthorizedCanary,assessS5StagingEvidence,
  type S5CanaryAuthorization,type S5StagingObservation,
} from '../src/ops/scale-s5-staging-acceptance.js';
const plan=():S5CanaryAuthorization=>({
  type:'bounded-external-staging-only',
  approvedHostname:'wss-stage.example.net',
  stagingResourceId:'staging-resource-12345',
  ownerApprovalRef:'operator-approval-12345',
  operatorWssTrustProfileSha256:'e'.repeat(64),
  signedStagingEnrollmentManifestSha256:'f'.repeat(64),
  distinctAuthorizedAccounts:2,
  distinctAuthorizedDeviceSessions:112,
  maxSimultaneousConnections:112,
  maxPerSecondNewConnections:4,
  maxLogicalRequests:300,
  maxRunSeconds:75,
  paidResourcesAllowed:false,
  nativeReadOnlyOperationApproved:true,
  stopOnFirstProviderError:true,
});
const observation=():S5StagingObservation=>({
  kind:'externally-observed-unverified',
  targetHost:'wss-stage.example.net',
  sourceCommit:'a'.repeat(40),
  startedAtUtc:'2026-10-19T12:00:00Z',
  endedAtUtc:'2026-10-19T12:01:00Z',
  peakSimultaneousAuthenticatedWss:112,
  peakSimultaneousUnverifiedWss:112,
  distinctAccounts:2,distinctAuthorizedDevices:112,
  attemptedReadOnlyNativeTools:150,
  ownerQuotaReservations:150,
  nativeCompletedReported:140,
  nativeCompletedIndependentlyVerified:140,
  p95Ms:300,p99Ms:450,
  reconnectAttempts:10,backpressureDenied:3,ingressTransportDenied:1,
  simulatedCompletedCount:0,
  externalAuthEvidenceSha256:'b'.repeat(64),
  nativeCompletionArtifactSha256:'c'.repeat(64),
  cloudflareMeterArtifactSha256:'d'.repeat(64),
});
test('Old 360 cumulative reconnects with peak 21 cannot count as >100 WSS',()=>{
  const o={...observation(),peakSimultaneousAuthenticatedWss:21,distinctAuthorizedDevices:21};
  const result=assessS5StagingEvidence(plan(),o);
  assert.equal(result.stagingStatus,'BLOCKED');
  assert.ok(result.reasons.some(x=>x.includes('100+ simultaneously')));
  assert.equal(result.productionStatus,'NO_GO');
});
test('Self-provided imaginary full evidence NEVER becomes staging or production PASS',()=>{
  const result=assessS5StagingEvidence(plan(),observation());
  assert.equal(validateS5AuthorizedCanary(plan()).length,0);
  assert.equal(result.stagingStatus,'NEEDS_INDEPENDENT_AUDIT');
  assert.equal(result.independentlyAuthenticatedEvidence,false);
  assert.equal(result.productionStatus,'NO_GO');
  assert.equal(result.native24HourSoakStatus,'NOT_VERIFIED');
});
test('Missing staging authorization and real native effects fail closed',()=>{
  assert.equal(assessS5StagingEvidence(null,null).stagingStatus,'BLOCKED');
  const o={...observation(),nativeCompletedReported:0,
    nativeCompletedIndependentlyVerified:0};
  assert.equal(assessS5StagingEvidence(plan(),o).stagingStatus,'BLOCKED');
  const wrong={...observation(),targetHost:'production.example.net'};
  assert.ok(assessS5StagingEvidence(plan(),wrong).reasons.some(x=>x.includes('differs from approved')));
});
test('Paid resources, request burst, session cap and missing owner approval denied',()=>{
  for(const x of [
    {...plan(),paidResourcesAllowed:true},
    {...plan(),maxSimultaneousConnections:256},
    {...plan(),maxPerSecondNewConnections:100},
    {...plan(),maxLogicalRequests:2000},
    {...plan(),ownerApprovalRef:''},
    {...plan(),nativeReadOnlyOperationApproved:false},
    {...plan(),approvedHostname:'localhost'},
  ] as S5CanaryAuthorization[])assert.ok(validateS5AuthorizedCanary(x).length>0);
});
test('Invalid latency, inconsistent quota and missing artifact hashes denied',()=>{
  for(const o of [
    {...observation(),p99Ms:100},
    {...observation(),nativeCompletedReported:151},
    {...observation(),nativeCompletedIndependentlyVerified:141},
    {...observation(),cloudflareMeterArtifactSha256:null},
    {...observation(),simulatedCompletedCount:1},
  ])assert.equal(assessS5StagingEvidence(plan(),o).stagingStatus,'BLOCKED');
});
