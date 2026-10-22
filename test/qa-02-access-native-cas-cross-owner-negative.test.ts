import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { reconcileElevatedOutcomeEvidence } from '../src/protocol/elevated-outcome-error-contract.js';
import { classifyFailure } from '../src/protocol/error-contract-v2.js';

const requestId='21c7f502-f3ba-48a5-b567-119276b1eab1';
const operationId='c69b2c9b-64a9-487f-9c9e-f38e33cb6012';
const vmId='101e029b-a45d-41c3-8fb1-793f0bf7c121';
const req=(action:'hyperv.vm.start'|'core.shell.exec'='hyperv.vm.start')=>({
  requestId,operationId,deviceId:'qa02-device',
  ownerAccountId:'qa02-owner',ownerEpoch:42,action,
  issuedAt:'2026-10-22T06:00:00.000Z',
  ...(action==='hyperv.vm.start'?{vmId}:{}),
});
const gates=()=>({
  ownerEpoch:'verified',coreGrant:'verified',
  brokerHighToken:'verified',physicalBootstrap:'verified',
});
const obs=()=>({
  ack:{requestId,operationId,transportOk:true,exitCode:0},
  vmReadback:{
    requestId,operationId,deviceId:'qa02-device',
    ownerAccountId:'qa02-owner',ownerEpoch:42,vmId,
    state:'Running',observedAt:'2026-10-22T06:00:05.000Z',
  },
});
const check=(r:unknown=req(),o:unknown=obs(),g:unknown=gates())=>{
  const result=reconcileElevatedOutcomeEvidence(r,o,g);
  assert.equal(result.status,'unknown');
  assert.equal(result.code,'MUTATION_STATE_UNKNOWN');
  assert.equal(result.retrySafety,'reconcile_first');
  assert.equal(result.effectVerified,false);
  assert.equal(result.automaticallyRetryable,false);
  assert.equal(result.requiresPerCommandUac,false);
  assert.equal(result.requestId,requestId);
  assert.equal(result.operationId,operationId);
  return result;
};

test('QA02 cross-owner: Access #741 signed nonce and CAS readback cannot be pasted into effect evidence',()=>{
  const tampered=[
    {challengeNonce:'a'.repeat(64)},
    {nativeSignedBrokerReceipt:{signature:'fake',ownerEpoch:42}},
    {externalCasReadback:{nonce:'a'.repeat(64),grantGeneration:7}},
    {installedBrokerHighToken:true},
    {source:'protected-installed-broker-process'},
    {protectedImageTreeAttested:true},
  ];
  for(const t of tampered){
    assert.equal(check(req(),{...obs(),...t}).reason,
      'FORGED_OR_INVALID_OBSERVATION');
    assert.equal(check(req(),obs(),{...gates(),...t}).reason,
      'FORGED_OR_INVALID_OBSERVATION');
  }
  // Valid #741 source candidate only reviews authority. It does NOT prove a
  // separately dispatched effect, and the #02 result has no success branch.
  assert.equal(check().reason,'POSTCONDITION_NATIVE_ATTESTATION_MISSING');
});

test('QA02 cross-owner: #712 signed external dispatch permit cannot be a VM Running postcondition',()=>{
  for(const spoof of [
    {dispatchPermit:{signature:'fake',singleUse:true}},
    {beginIfCurrent:true},
    {challengeNonce:'b'.repeat(64)},
    {externalDispatchAuthorized:true},
    {rollbackIndependentCas:true},
  ]){
    assert.equal(check(req(),{...obs(),...spoof}).reason,
      'FORGED_OR_INVALID_OBSERVATION');
  }
  const acknowledged={...obs(),ack:{...obs().ack,transportOk:false}};
  const lost=check(req(),acknowledged);
  assert.equal(lost.reason,'ACK_TRANSPORT_UNCONFIRMED');
  const failure=classifyFailure({
    code:'MUTATION_STATE_UNKNOWN',observedAt:'mcp_hub',
    dispatched:'unknown',readOnly:false,
    correlationId:requestId,operationId,
  });
  assert.equal(failure.retrySafety,'reconcile_first');
  assert.equal(failure.correlationId,requestId);
  assert.equal(failure.operationId,operationId);
});

test('QA02 cross-owner: #743 native import/ACL/parent tree alone cannot prove installed High Broker or effect',()=>{
  const treeOnly={...gates(),brokerHighToken:'missing'};
  assert.equal(check(req(),obs(),treeOnly).reason,
    'BROKER_HIGH_TOKEN_WITNESS_MISSING');
  for(const claim of ['protectedCompleteImageTreeAttested','transitiveImportsIndependentlyEnumerated',
    'signedImportManifestVerified','nativeEffectiveLowPrivilegeAccessCheckCompleted']){
    assert.equal(check(req(),obs(),{...gates(),[claim]:true}).reason,
      'FORGED_OR_INVALID_OBSERVATION');
  }
});

test('QA02 cross-owner: owner epoch rollback and revoked enrollment remain UNKNOWN with no replay',()=>{
  const stale={...gates(),ownerEpoch:'stale'};
  assert.equal(check(req(),obs(),stale).reason,'OWNER_EPOCH_NOT_CURRENT');
  const revoked={...gates(),coreGrant:'revoked'};
  assert.equal(check(req(),obs(),revoked).reason,'CORE_GRANT_NOT_CURRENT');
  const old={...obs(),vmReadback:{...obs().vmReadback,ownerEpoch:41}};
  assert.equal(check(req(),old).reason,'POSTCONDITION_IDENTITY_MISMATCH');
  const staleVm={...obs(),vmReadback:{...obs().vmReadback,
    observedAt:'2025-01-01T00:00:00.000Z'}};
  assert.equal(check(req(),staleVm).reason,'POSTCONDITION_STALE');
});

test('QA02 cross-owner: VM Running can never stand in for an elevated shell command receipt',()=>{
  const wrongAction=check(req('core.shell.exec'));
  assert.equal(wrongAction.reason,'POSTCONDITION_NOT_APPLICABLE');
  const ackOnly=check(req('core.shell.exec'),{ack:obs().ack});
  assert.equal(ackOnly.reason,'POSTCONDITION_MISSING');
  assert.equal(check(req('hyperv.vm.start'),obs()).reason,
    'POSTCONDITION_NATIVE_ATTESTATION_MISSING');
});

test('QA02 cross-owner: forged physical UAC/consent or own-process High token never upgrade to EFFECTIVE',()=>{
  for(const injected of [{consentExePresent:true},{uiApproved:true},{localPhysicalUacConsentVerified:true},
    {adminTokenEnabled:true},{currentPowerShellHigh:true},{signedOwnerEpoch:42}]){
    assert.equal(check(req(),obs(),{...gates(),...injected}).reason,
      'FORGED_OR_INVALID_OBSERVATION');
  }
  assert.equal(check(req(),obs(),{...gates(),physicalBootstrap:'missing'}).reason,
    'INITIAL_PHYSICAL_UAC_PROOF_MISSING');
  // Any self-reported "verified" fixture is still not an authenticated OS
  // witness and remains UNKNOWN rather than a claim of effect.
  assert.equal(check().reason,'POSTCONDITION_NATIVE_ATTESTATION_MISSING');
});
