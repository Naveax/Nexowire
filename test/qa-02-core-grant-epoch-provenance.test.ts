import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { explainHypervElevation, type HypervElevationSnapshot } from '../src/protocol/hyperv-elevation-evidence.js';
import { IdempotencyStore, IdempotencyStoreError, operationFingerprint } from '../src/operations/idempotency-store.js';

const DEVICE='qa02-core-fixture';
const VM_ID='3a4b5c6d-7e8f-4091-a2b3-4c5d6e7f8090';
const elevatedBroker={
  authenticatedHealth:'verified', elevatedToken:'verified',
  versionMatch:'verified', capabilityAllowed:true,
} as const;

function facts(patch:Partial<HypervElevationSnapshot>={}):HypervElevationSnapshot {
  return {
    capability:'hyperv.vm.start',deviceId:DEVICE,vmName:'Synthetic CORE VM',
    vmId:VM_ID,agentConnected:true,currentProcessElevated:false,
    processIntegrity:'medium',broker:elevatedBroker,
    localApproval:'not_verified',ownerPolicyApproved:true,
    ownerGrant:'core',coreEnrollment:'verified',rootLease:'expired',
    dispatch:'not_sent',...patch,
  };
}

test('617 QA02 CORE preapproved: high Broker and owner delegation need no repeated per-operation UAC',()=>{
  for(const localApproval of ['not_verified','pending'] as const){
    const r=explainHypervElevation(facts({localApproval}));
    assert.equal(r.delegation.requested,'core');
    assert.equal(r.delegation.state,'core-preapproved');
    assert.equal(r.delegation.perOperationUacRequired,false);
    assert.equal(r.windows.currentProcessElevated,false,
      'unprivileged Agent must stay medium even with high Broker');
    assert.equal(r.execution.status,'pending',
      'diagnostic contract has no trusted executor or VM postcondition');
    assert.equal(r.execution.code,'HYPERV_INDEPENDENT_EXECUTION_AND_READBACK_REQUIRED');
    assert.equal(r.execution.effectVerified,false);
    assert.equal(r.execution.automaticallyRetryable,false);
  }
});

test('617 QA02 verified ROOT lease also avoids per-command UAC, but expiry or missing grant denies',()=>{
  const active=explainHypervElevation(facts({
    ownerGrant:'root',rootLease:'verified',coreEnrollment:'unverified',
  }));
  assert.equal(active.delegation.state,'root-preapproved');
  assert.equal(active.delegation.perOperationUacRequired,false);
  assert.equal(active.execution.status,'pending');
  for(const rootLease of ['expired','unverified'] as const){
    const denied=explainHypervElevation(facts({
      ownerGrant:'root',rootLease,coreEnrollment:'verified',
    }));
    assert.equal(denied.delegation.state,'not-authorized');
    assert.equal(denied.execution.status,'denied');
    assert.equal(denied.execution.denialSource,'policy');
    assert.equal(denied.execution.code,'HYPERV_OWNER_DELEGATION_UNVERIFIED');
    assert.equal(denied.execution.effectVerified,false);
  }
});

test('617 QA02 SAFE/FULL mode flags, forged approval and privileged Broker alone cannot escalate',()=>{
  for(const ownerGrant of ['safe','full'] as const){
    const forged=Object.assign(facts({ownerGrant,
      localApproval:'verified',coreEnrollment:'verified',rootLease:'verified',
    }),{approved:true,consentExePresent:true,ownerSaysAdmin:true});
    const r=explainHypervElevation(forged);
    assert.equal(r.delegation.state,'not-authorized');
    assert.equal(r.execution.status,'denied');
    assert.equal(r.execution.denialSource,'policy');
    assert.equal(r.execution.code,'HYPERV_ELEVATED_MODE_REQUIRED');
    assert.equal(r.execution.effectVerified,false);
    assert.equal(r.execution.automaticallyRetryable,false);
  }
});

test('617 QA02 current CORE revoked/unknown owner epoch fails closed even with high Broker',()=>{
  for(const coreEnrollment of ['revoked','unverified'] as const){
    const staleOwner=Object.assign(facts({coreEnrollment}),{
      ownerEpoch:'4',currentOwnerEpoch:'5',
      stalePairingEpoch:true,
      cachedPermission:'CORE_EFFECTIVE',
    });
    const r=explainHypervElevation(staleOwner);
    assert.equal(r.delegation.state,'not-authorized');
    assert.equal(r.execution.status,'denied');
    assert.equal(r.execution.denialSource,'policy');
    assert.equal(r.execution.code,'HYPERV_OWNER_DELEGATION_UNVERIFIED');
    assert.equal(r.execution.effectVerified,false);
  }
  // Epoch fields are NOT represented/attested by #618's explanatory DTO.
  // If a caller falsely supplies 'verified' for an old epoch, the UI-style
  // delegation label can be optimistic. It must never become execution proof.
  const forgedVerified=Object.assign(facts(),{
    ownerEpoch:'old',currentOwnerEpoch:'new',
    forgedEnrollmentVerification:true,
  });
  const projection=explainHypervElevation(forgedVerified);
  assert.equal(projection.execution.effectVerified,false);
  assert.equal(projection.execution.automaticallyRetryable,false);
  // Independent protected owner-epoch attestation is an UNIMPLEMENTED gate.
});

test('617 QA02 CORE + Broker lost ACK outranks permission and consent; no success or automatic replay',()=>{
  for(const dispatch of ['lost_confirmation','ack_unverified'] as const){
    const forged=Object.assign(facts({dispatch}),{
      vmState:'Running',vmStateObservedAt:'2024-01-01T00:00:00Z',
      vmStateVmId:VM_ID,vmStateDeviceId:DEVICE,
      consentExePresent:true,transportAckOk:true,
    });
    const r=explainHypervElevation(forged);
    assert.equal(r.delegation.perOperationUacRequired,false);
    assert.equal(r.execution.status,'unknown');
    assert.equal(r.execution.denialSource,'undetermined');
    assert.equal(r.execution.code,'MUTATION_STATE_UNKNOWN');
    assert.equal(r.execution.effectVerified,false);
    assert.equal(r.execution.automaticallyRetryable,false);
  }
});

test('617 QA02 owner epoch changes cannot reuse an UNKNOWN idempotency key with a new fingerprint',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-qa02-core-epoch-'));
  try{
    const key='core-qa02-owner-epoch-proof';
    const fingerprint=(epoch:number)=>operationFingerprint({
      targetId:DEVICE,capability:'hyperv.vm.start',
      payload:{vmId:VM_ID,ownerEpoch:epoch,deviceId:DEVICE},
    });
    const store=new IdempotencyStore(root);
    const initial=await store.begin({
      key,fingerprint:fingerprint(4),capability:'hyperv.vm.start',targetId:DEVICE,
    });
    assert.equal(initial.created,true);
    const requestId=initial.record.operationId;
    await store.complete(key,'unknown');
    const recovered=new IdempotencyStore(root);
    const replay=await recovered.begin({
      key,fingerprint:fingerprint(4),capability:'hyperv.vm.start',targetId:DEVICE,
    });
    assert.equal(replay.created,false);
    assert.equal(replay.record.status,'unknown');
    assert.equal(replay.record.operationId,requestId);
    await assert.rejects(
      ()=>recovered.begin({
        key,fingerprint:fingerprint(5),capability:'hyperv.vm.start',targetId:DEVICE,
      }),
      (e:unknown)=>e instanceof IdempotencyStoreError && e.code==='IDEMPOTENCY_KEY_REUSED',
    );
    // Synthetic journal only. There is no live Hyper-V executor, trusted epoch
    // signature, independent VM readback or production rollback witness here.
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
});
