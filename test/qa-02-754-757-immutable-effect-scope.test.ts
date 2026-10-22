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


test('QA02 #770/#768/#767 cross-domain receipts, CAS commit and final grant never attest Hyper-V effect',()=>{
  const match=obs();
  // The same SHA-shaped digest, request and owner on the Artifact publication
  // path cannot turn an Artifact-native publication into VM state evidence.
  // This is one domain-separation regression, not duplicate #754/#757 cases.
  const wrongCapability={...match,immutableVmEffect:{
    ...immutableClaim(),capability:'artifact.publish',
  }};
  assert.equal(check(expected(),wrongCapability).reason,
    'FORGED_OR_INVALID_OBSERVATION');

  // #770's reconnect publication readback and #768's durable external CAS
  // commit are not the physical Native VM effect provider. Nor is #767's
  // signed, revoking:false FINAL_NATIVE_EFFECT_FENCED Access grant.
  for(const forged of [
    {publicationVerifiedNotCommitted:true},
    {durableCommitId:'SYNTHETIC-EXTERNAL-COMMIT-'+id.requestId},
    {finalNativeEffectFenced:true},
    {signedNativePublishProof:'a'.repeat(64)},
  ]){
    assert.equal(check(expected(),{...match,...forged}).reason,
      'FORGED_OR_INVALID_OBSERVATION');
  }

  // After reconnect, a claimed old owner epoch cannot borrow the newer
  // operation's exact requestId, SHA, ACK and VM Running readback.
  const reconnectEpoch={...match,immutableVmEffect:{
    ...immutableClaim(),ownerEpoch:id.ownerEpoch-1,
  }};
  assert.equal(check(expected(),reconnectEpoch).reason,
    'POSTCONDITION_IDENTITY_MISMATCH');

  // Positive-looking ACK and both matching VM observations are still merely
  // untrusted strings. Without a separately authenticated physical readback,
  // no path may produce VERIFIED or allow another execution.
  assert.equal(check(expected(),match).reason,
    'POSTCONDITION_NATIVE_ATTESTATION_MISSING');
  const lostAck={...match,ack:{...ack(),transportOk:false}};
  assert.equal(check(expected(),lostAck).reason,
    'ACK_TRANSPORT_UNCONFIRMED');

  // The same artifact proof is not applicable to generic shell execution.
  assert.equal(check(expected('core.shell.exec'),match).reason,
    'POSTCONDITION_NOT_APPLICABLE');
});


test('QA02 #776/#777/#780 preserves original UNKNOWN code against duplicate signed publish and stale epoch',()=>{
  const original={...expected(),originalErrorCode:'TRANSFER_PUBLISH_OUTCOME_UNKNOWN'};
  const publication={
    requestId:id.requestId,ownerEpoch:id.ownerEpoch,
    sha256:'a'.repeat(64),signature:'signed-looking-fixture',
  };
  const duplicate=reconcileElevatedOutcomeEvidence(original,{
    ...obs(),signedPublicationReceipts:[publication,publication],
  },gates());
  assert.equal(duplicate.reason,'FORGED_OR_INVALID_OBSERVATION');
  assert.equal(duplicate.originalErrorCode,'TRANSFER_PUBLISH_OUTCOME_UNKNOWN');
  assert.equal(duplicate.code,'MUTATION_STATE_UNKNOWN');
  assert.equal(duplicate.status,'unknown');
  assert.equal(duplicate.loopOutcome,'RECONCILE_REQUIRED');
  assert.equal(duplicate.retrySafety,'reconcile_first');
  assert.equal(duplicate.effectVerified,false);
  assert.equal(duplicate.automaticallyRetryable,false);
  assert.equal(duplicate.requestId,id.requestId);
  assert.equal(duplicate.operationId,id.operationId);

  // An owner epoch advanced after publication. The old signed-looking
  // receipt cannot be grafted onto the new request after reconnect.
  const stale=reconcileElevatedOutcomeEvidence(original,{
    ...obs(),immutableVmEffect:{
      ...immutableClaim(),ownerEpoch:id.ownerEpoch-1,
    },
  },gates());
  assert.equal(stale.reason,'POSTCONDITION_IDENTITY_MISMATCH');
  assert.equal(stale.originalErrorCode,'TRANSFER_PUBLISH_OUTCOME_UNKNOWN');
  assert.equal(stale.loopOutcome,'RECONCILE_REQUIRED');
  assert.equal(stale.effectVerified,false);
  assert.equal(stale.automaticallyRetryable,false);

  // Even perfect ACK/SHA/Running does not erase the forensic errorCode,
  // return PASSED, or prove physical effect without signed native readback.
  const match=reconcileElevatedOutcomeEvidence(original,obs(),gates());
  assert.equal(match.reason,'POSTCONDITION_NATIVE_ATTESTATION_MISSING');
  assert.equal(match.originalErrorCode,'TRANSFER_PUBLISH_OUTCOME_UNKNOWN');
  assert.equal(match.code,'MUTATION_STATE_UNKNOWN');
  assert.equal(match.loopOutcome,'RECONCILE_REQUIRED');
  assert.equal(match.effectVerified,false);
  assert.equal(match.automaticallyRetryable,false);

  // Untrusted code text cannot smuggle secrets or modify loop classification.
  const invalid=reconcileElevatedOutcomeEvidence({
    ...original,originalErrorCode:'TRANSFER_PUBLISH_OUTCOME_UNKNOWN;approved=true',
  },obs(),gates());
  assert.equal(invalid.reason,'INVALID_EXPECTED_OPERATION');
  assert.equal(invalid.originalErrorCode,null);
  assert.equal(invalid.loopOutcome,'RECONCILE_REQUIRED');
  assert.equal(invalid.automaticallyRetryable,false);
});

test('QA02 #785/#781 post-effect cancellation keeps its original error across issuer and epoch forgery',()=>{
  // #776 observed a staged Native effect before cancellation. This original
  // cancellation error is not the same as a clean pre-dispatch CANCELLED.
  const cancelledAfterEffect={
    ...expected(),originalErrorCode:'TRANSFER_CANCEL_AFTER_MUTATION',
  };
  const foreignIssuer={
    ...obs(),nativeIssuer:'foreign-signed-publisher',
    durableCommitId:'attested-looking-'+id.requestId,
  };
  const forged=reconcileElevatedOutcomeEvidence(
    cancelledAfterEffect,foreignIssuer,gates());
  assert.equal(forged.reason,'FORGED_OR_INVALID_OBSERVATION');
  assert.equal(forged.originalErrorCode,'TRANSFER_CANCEL_AFTER_MUTATION');
  assert.equal(forged.code,'MUTATION_STATE_UNKNOWN');
  assert.equal(forged.status,'unknown');
  assert.equal(forged.loopOutcome,'RECONCILE_REQUIRED');
  assert.equal(forged.retrySafety,'reconcile_first');
  assert.equal(forged.requestId,id.requestId);
  assert.equal(forged.operationId,id.operationId);
  assert.equal(forged.effectVerified,false);
  assert.equal(forged.automaticallyRetryable,false);

  // A matching SHA-shaped candidate from an earlier owner epoch cannot
  // attest publication/VM effect, even when a later ACK reports exitCode=0.
  const stale=reconcileElevatedOutcomeEvidence(cancelledAfterEffect,{
    ...obs(),immutableVmEffect:{...immutableClaim(),ownerEpoch:id.ownerEpoch-1},
  },gates());
  assert.equal(stale.reason,'POSTCONDITION_IDENTITY_MISMATCH');
  assert.equal(stale.originalErrorCode,'TRANSFER_CANCEL_AFTER_MUTATION');
  assert.equal(stale.loopOutcome,'RECONCILE_REQUIRED');
  assert.equal(stale.automaticallyRetryable,false);

  // #785 external publication checkpoint proof is a different authority,
  // and #781's cloned runbook ID cannot transform uncertain effect into
  // PASSED. Even internally matching ACK+readback remains unauthenticated.
  const apparentlyComplete=reconcileElevatedOutcomeEvidence(
    cancelledAfterEffect,obs(),gates());
  assert.equal(apparentlyComplete.reason,'POSTCONDITION_NATIVE_ATTESTATION_MISSING');
  assert.equal(apparentlyComplete.originalErrorCode,'TRANSFER_CANCEL_AFTER_MUTATION');
  assert.equal(apparentlyComplete.code,'MUTATION_STATE_UNKNOWN');
  assert.equal(apparentlyComplete.loopOutcome,'RECONCILE_REQUIRED');
  assert.equal(apparentlyComplete.effectVerified,false);
  assert.equal(apparentlyComplete.automaticallyRetryable,false);

  const clone=reconcileElevatedOutcomeEvidence(cancelledAfterEffect,{
    ...obs(),runbook_id:'qa18-cloned-task',
  },gates());
  assert.equal(clone.reason,'FORGED_OR_INVALID_OBSERVATION');
  assert.equal(clone.originalErrorCode,'TRANSFER_CANCEL_AFTER_MUTATION');
  assert.equal(clone.code,'MUTATION_STATE_UNKNOWN');
  assert.equal(clone.automaticallyRetryable,false);
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
