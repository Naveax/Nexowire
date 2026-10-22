import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ElevatedExpectedOperationSchema,
  ElevatedUntrustedObservationSchema,
  reconcileElevatedOutcomeEvidence,
  type ElevatedReconciliationReason,
} from '../src/protocol/elevated-outcome-error-contract.js';
import { classifyFailure } from '../src/protocol/error-contract-v2.js';

const REQUEST='be4ce70e-a20e-40e2-a93e-c111eac18001';
const OP='2c1c37ef-2d4f-4443-9d9e-f0c0ef4cd001';
const VM='11d37104-9725-4bbf-b1e4-e5abfd229911';
const expected=()=>({
  requestId:REQUEST,operationId:OP,deviceId:'qa02-device',
  ownerAccountId:'qa02-owner',ownerEpoch:21,
  action:'hyperv.vm.start' as const,vmId:VM,
  issuedAt:'2026-10-21T15:00:00.000Z',
});
const trustedClaim=()=>({
  ownerEpoch:'verified',coreGrant:'verified',
  brokerHighToken:'verified',physicalBootstrap:'verified',
});
const readback=()=>({
  requestId:REQUEST,operationId:OP,deviceId:'qa02-device',
  ownerAccountId:'qa02-owner',ownerEpoch:21,vmId:VM,
  state:'Running' as const,observedAt:'2026-10-21T15:00:05.000Z',
});
const receipt=()=>({
  ack:{requestId:REQUEST,operationId:OP,transportOk:true,exitCode:0},
  vmReadback:readback(),
});
const assess=(e:unknown=expected(),o:unknown=receipt(),g:unknown=trustedClaim())=>
  reconcileElevatedOutcomeEvidence(e,o,g);
function unknown(reason:ElevatedReconciliationReason,e:unknown=expected(),
  o:unknown=receipt(),g:unknown=trustedClaim()){
  const result=assess(e,o,g);
  assert.equal(result.reason,reason);
  assert.equal(result.status,'unknown');
  assert.equal(result.code,'MUTATION_STATE_UNKNOWN');
  assert.equal(result.denialSource,'undetermined');
  assert.equal(result.dispatchState,'unknown');
  assert.equal(result.retrySafety,'reconcile_first');
  assert.equal(result.automaticallyRetryable,false);
  assert.equal(result.effectVerified,false);
  assert.equal(result.requiresPerCommandUac,false);
  if(ElevatedExpectedOperationSchema.safeParse(e).success){
    assert.equal(result.requestId,REQUEST);
    assert.equal(result.operationId,OP);
  }
  return result;
}

test('QA02 output contract keeps UNKNOWN even for matching ack exit 0 and Running readback',()=>{
  unknown('POSTCONDITION_NATIVE_ATTESTATION_MISSING');
  assert.equal(ElevatedUntrustedObservationSchema.safeParse(receipt()).success,true);
});

test('QA02 forged consent.exe, UAC approval or High token fields are not admitted as evidence',()=>{
  for(const claim of [{physicalUacApproved:true},{consentExePresent:true},
    {approvedByUser:true},{highTokenVerified:true},{signedReceipt:true},
    {producer:'native-broker'},{source:'windows-native'}]){
    unknown('FORGED_OR_INVALID_OBSERVATION',expected(),{...receipt(),...claim});
  }
  for(const falseGate of [{physicalUacApproved:true},{consentExeSeen:true},
      {tokenIsHigh:true},{ownerEpochProof:'signed'}]){
    unknown('FORGED_OR_INVALID_OBSERVATION',expected(),receipt(),
      {...trustedClaim(),...falseGate});
  }
});

test('QA02 missing current owner epoch, revoked CORE and missing Broker token witness have distinct errors',()=>{
  for(const state of ['missing','stale'] as const){
    unknown('OWNER_EPOCH_NOT_CURRENT',expected(),receipt(),{...trustedClaim(),ownerEpoch:state});
  }
  for(const state of ['missing','revoked'] as const){
    unknown('CORE_GRANT_NOT_CURRENT',expected(),receipt(),{...trustedClaim(),coreGrant:state});
  }
  unknown('BROKER_HIGH_TOKEN_WITNESS_MISSING',expected(),receipt(),
    {...trustedClaim(),brokerHighToken:'missing'});
  unknown('INITIAL_PHYSICAL_UAC_PROOF_MISSING',expected(),receipt(),
    {...trustedClaim(),physicalBootstrap:'missing'});
});

test('QA02 preapproved signed CORE does not imply repeated UAC or successful physical execution',()=>{
  const out=unknown('POSTCONDITION_NATIVE_ATTESTATION_MISSING');
  assert.equal(out.requiresPerCommandUac,false);
  // The all-"verified" fixture has NO cryptographically authenticated
  // owner epoch, external CAS or independently attested Windows VM witness.
  assert.equal(out.effectVerified,false);
});

test('QA02 missing postcondition and ACK-only (even exit 0) remain UNKNOWN',()=>{
  unknown('POSTCONDITION_MISSING',expected(),{ack:receipt().ack});
  unknown('POSTCONDITION_MISSING',expected(),{});
  unknown('ACK_REQUEST_ID_MISMATCH',expected(),{
    ...receipt(),ack:{...receipt().ack,requestId:randomUUID()},
  });
  unknown('ACK_REQUEST_ID_MISMATCH',expected(),{
    ...receipt(),ack:{...receipt().ack,operationId:randomUUID()},
  });
});

test('QA02 wrong VM, host, owner epoch, operationId and requestId are never accepted',()=>{
  const invalid=[
    {requestId:randomUUID()},{operationId:randomUUID()},
    {deviceId:'other-device'},{ownerAccountId:'former-owner'},
    {ownerEpoch:20},{vmId:randomUUID()},
  ];
  for(const patch of invalid){
    unknown('POSTCONDITION_IDENTITY_MISMATCH',expected(),{
      ...receipt(),vmReadback:{...readback(),...patch},
    });
  }
});

test('QA02 stale Running, wrong state and future clock tricks never claim effect',()=>{
  for(const observedAt of ['2025-01-01T00:00:00.000Z',
    '2026-10-21T15:00:00.000Z']){
    unknown('POSTCONDITION_STALE',expected(),{
      ...receipt(),vmReadback:{...readback(),observedAt},
    });
  }
  for(const state of ['Off','Unknown'] as const){
    unknown('POSTCONDITION_STATE_MISMATCH',expected(),{
      ...receipt(),vmReadback:{...readback(),state},
    });
  }
});

test('QA02 unknown target and untyped forged success fields fail closed',()=>{
  const req=expected();
  const badReqs=[{...req,action:'hyperv.vm.start',vmId:undefined},
    {...req,approved:true},{...req,ownerEpoch:0},
    {...req,requestId:'synthetic-bad-id'},{...req,action:'core.shell.exec'}];
  for(const invalid of badReqs){
    const res=assess(invalid);
    assert.equal(res.reason,'INVALID_EXPECTED_OPERATION');
    assert.equal(res.effectVerified,false);
    assert.equal(res.automaticallyRetryable,false);
  }
});

test('QA02 DPAPI child timeout after possible mutation retains operation and request correlation',()=>{
  const res=assess(expected(),{});
  assert.equal(res.status,'unknown');
  assert.equal(res.operationId,OP);
  assert.equal(res.requestId,REQUEST);
  const classified=classifyFailure({
    code:'WINDOWS_DPAPI_FAILED',observedAt:'windows_wsl',
    dispatched:'unknown',readOnly:false,correlationId:REQUEST,operationId:OP,
  });
  assert.equal(classified.retrySafety,'reconcile_first');
  assert.equal(classified.operationId,res.operationId);
  assert.equal(classified.correlationId,res.requestId);
});
