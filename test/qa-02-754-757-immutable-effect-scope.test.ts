import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {reconcileElevatedOutcomeEvidence}
  from '../src/protocol/elevated-outcome-error-contract.js';

const id={
  requestId:'42b7f08c-a274-41a8-832b-a6123a6a9d35',
  operationId:'015ab91a-0b4b-47b6-bb4c-661cb17cb80b',
  deviceId:'qa02-target',ownerAccountId:'qa02-owner',ownerEpoch:57,
  vmId:'b44bc4f5-4118-4024-8d77-8e203987f449',
};
const expected=(action:'hyperv.vm.start'|'hyperv.vm.stop'|'core.shell.exec'=
  'hyperv.vm.start')=>({
  ...id,action,issuedAt:'2026-10-22T12:00:00.000Z',
  ...(action==='core.shell.exec'?{vmId:undefined}:{}),
});
const gates=()=>({
  ownerEpoch:'verified',coreGrant:'verified',
  brokerHighToken:'verified',physicalBootstrap:'verified',
});
const ack=()=>({requestId:id.requestId,operationId:id.operationId,
  transportOk:true,exitCode:0});
const vmReadback=()=>({
  ...id,state:'Running' as const,observedAt:'2026-10-22T12:00:02.000Z',
});
const immutableClaim=()=>({
  ...id,capability:'hyperv.vm.start' as const,state:'Running' as const,
  stateSha256:'a'.repeat(64),
  observedAt:'2026-10-22T12:00:03.000Z',
});
const obs=()=>({
  ack:ack(),vmReadback:vmReadback(),immutableVmEffect:immutableClaim(),
});
const check=(r:unknown=expected(),o:unknown=obs())=>{
  const out=reconcileElevatedOutcomeEvidence(r,o,gates());
  assert.equal(out.status,'unknown');
  assert.equal(out.code,'MUTATION_STATE_UNKNOWN');
  assert.equal(out.retrySafety,'reconcile_first');
  assert.equal(out.effectVerified,false);
  assert.equal(out.automaticallyRetryable,false);
  assert.equal(out.requestId,id.requestId);
  assert.equal(out.operationId,id.operationId);
  return out;
};

test('QA02 #754 ACK success cannot replace independently authenticated immutable target effect',()=>{
  // #754 publication proof accepts final output only after independent
  // verifier AND destination readback. #02 VM candidate is NOT either one.
  assert.equal(check().reason,'POSTCONDITION_NATIVE_ATTESTATION_MISSING');
  assert.equal(check(expected(),{ack:ack()}).reason,'POSTCONDITION_MISSING');
  assert.equal(check(expected(),{
    ack:ack(),immutableVmEffect:immutableClaim(),
  }).reason,'POSTCONDITION_NATIVE_ATTESTATION_MISSING');
  const otherId={...obs(),immutableVmEffect:{
    ...immutableClaim(),requestId:randomUUID(),
  }};
  assert.equal(check(expected(),otherId).reason,
    'POSTCONDITION_IDENTITY_MISMATCH');
  const stale={...obs(),immutableVmEffect:{
    ...immutableClaim(),observedAt:'2025-01-01T00:00:00.000Z',
  }};
  assert.equal(check(expected(),stale).reason,'POSTCONDITION_STALE');
  const incompatible={...obs(),vmReadback:{...vmReadback(),state:'Off'}};
  assert.equal(check(expected(),incompatible).reason,
    'POSTCONDITION_RECEIPT_INCONSISTENT');
  const malformed={...obs(),immutableVmEffect:{
    ...immutableClaim(),stateSha256:'not-an-immutable-digest',
  }};
  assert.equal(check(expected(),malformed).reason,
    'FORGED_OR_INVALID_OBSERVATION');
});

test('QA02 #757 revoke and capability scope: VM state is inapplicable to shell, late permit never creates success',()=>{
  const shell=expected('core.shell.exec');
  assert.equal(check(shell).reason,'POSTCONDITION_NOT_APPLICABLE');
  assert.equal(check(shell,{ack:ack(),immutableVmEffect:immutableClaim()})
    .reason,'POSTCONDITION_NOT_APPLICABLE');
  const stop=expected('hyperv.vm.stop');
  assert.equal(check(stop).reason,'POSTCONDITION_CAPABILITY_MISMATCH');
  const apparentlyValidStop={
    ack:ack(),
    immutableVmEffect:{
      ...immutableClaim(),capability:'hyperv.vm.stop',
      state:'Off',
    },
    vmReadback:{...vmReadback(),state:'Off'},
  };
  assert.equal(check(stop,apparentlyValidStop).reason,
    'POSTCONDITION_NATIVE_ATTESTATION_MISSING');

  // #757 validates revoking before permit use; this source-only #02
  // reconciler must NOT accept a caller-provided revoked=false claim.
  for(const claim of [{revoking:false},{lateSignedPermit:true},
    {externalCasAuthorized:true},{claimAlreadyExecuted:true}]){
    assert.equal(check(expected(),{...obs(),...claim}).reason,
      'FORGED_OR_INVALID_OBSERVATION');
  }
});
