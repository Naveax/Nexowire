import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  CoreBrokerExecutionRequestSchema,
  evaluateCoreBrokerExecution,
  type CoreBrokerContext,
} from '../src/security/core-broker-executor-contract.js';
import { classifyFailure } from '../src/protocol/error-contract-v2.js';
import { IdempotencyStore, IdempotencyStoreError, operationFingerprint } from '../src/operations/idempotency-store.js';
import { AuditLog } from '../src/audit/log.js';

const SHA='a'.repeat(64);
const OTHER_SHA='b'.repeat(64);
const VM_ID='2eb71c03-a5f2-4f16-bbbf-c0d29ee2a791';
const BASE_TIME=new Date('2026-10-21T13:00:00.000Z');
const BEARER='QA02SyntheticNeverPersistThisBearerToken123';

const request=(action:'core.shell.exec'|'hyperv.vm.start'='core.shell.exec',requestId=randomUUID())=>({
  type:'core-broker.execute' as const,version:1 as const,requestId,
  deviceId:'device-qa02',ownerAccountId:'owner-qa02',ownerEpoch:42,
  credentialBinding:SHA,mode:'CORE' as const,action,
  issuedAt:'2026-10-21T12:59:40.000Z',expiresAt:'2026-10-21T13:00:20.000Z',
  ...(action==='core.shell.exec'
    ? {shell:{executable:'C:\\Windows\\System32\\cmd.exe',
        arguments:['/C','echo synthetic-NOT-EXECUTED']}}
    : {vmId:VM_ID}),
});
function trusted():CoreBrokerContext {
  return {
    now:new Date(BASE_TIME),deviceId:'device-qa02',ownerAccountId:'owner-qa02',
    authoritativeOwnerEpoch:42,credentialBinding:SHA,ownerRevoked:false,
    enrollment:{deviceId:'device-qa02',ownerAccountId:'owner-qa02',ownerEpoch:42,
      credentialBinding:SHA,enrollmentId:randomUUID(),mode:'CORE',
      activatedAt:'2026-10-21T12:55:00.000Z',expiresAt:null,
      ownerSignedGrantDigest:OTHER_SHA,brokerInstalledImageSha256:SHA},
    localBootstrap:{
      localPhysicalUacConsentVerified:true,
      signedEnrollmentStoredInProtectedBroker:true,
      trustedInstallerRollbackBindingVerified:true},
    trustedRuntime:{
      evidenceProvenance:'independent-windows-native',brokerProcessHighIntegrity:true,
      administratorsTokenEnabled:true,brokerAuthenticatedAndVersionMatched:true,
      runningImageIdentityMatched:true,expectedBrokerImageSha256:SHA,
      imageAuthenticodePublisherPinned:true,signedReleaseAndRollbackManifestVerified:true,
      brokerExeAndParentAclProtected:true,importedModulesAclProtected:true,
      updaterPathsAclProtected:true,processHandleDuplicationBoundaryProtected:true,
    },
    ownerIntentSignatureVerified:true,enrollmentSignatureVerified:true,
    ownerEpochWitnessVerified:true,requestAlreadyReserved:()=>false,
    pendingMutationUnknown:false,approvedVmIds:[VM_ID],stopProcessIdentityVerified:true,
  };
}

/** QA-only evidence oracle: does NOT attest an actual Windows token or VM. */
interface Receipt {
  requestId:string;ownerEpoch:number;ownerAccountId:string;deviceId:string;
  vmId:string;observedAt:string;state:string;
  independentNativeAttestation:boolean;
  effectObservationFromActualTarget:boolean;
}
function acceptSyntheticEffect(requestId:string,minimumObservedAt:string,receipt:Receipt|undefined):boolean {
  if(!receipt||!receipt.independentNativeAttestation||
      !receipt.effectObservationFromActualTarget)return false;
  return receipt.requestId===requestId&&receipt.ownerEpoch===42&&
    receipt.ownerAccountId==='owner-qa02'&&receipt.deviceId==='device-qa02'&&
    receipt.vmId===VM_ID&&receipt.state==='Running'&&
    Number.isFinite(Date.parse(receipt.observedAt))&&
    Date.parse(receipt.observedAt)>Date.parse(minimumObservedAt);
}
const receipt=(requestId:string):Receipt=>({
  requestId,ownerEpoch:42,ownerAccountId:'owner-qa02',deviceId:'device-qa02',
  vmId:VM_ID,observedAt:'2026-10-21T13:00:10.000Z',state:'Running',
  independentNativeAttestation:true,effectObservationFromActualTarget:true,
});

test('QA02 elevated CORE requestId is required, exact, and never synthesized from an ACK',()=>{
  const id=randomUUID(),r=request('core.shell.exec',id);
  assert.equal(CoreBrokerExecutionRequestSchema.safeParse(r).success,true);
  const result=evaluateCoreBrokerExecution(r,trusted());
  assert.equal(result.requestId,id);
  assert.equal(result.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  assert.equal(result.privilegedExecutionOccurred,false);
  assert.equal(result.verifiedEffect,false);
  assert.equal(result.requiresPerCommandUac,false);
  for(const fake of [{...r,requestId:'old-request'},
    {...r,requestId:'00000000-0000-0000-0000-000000000000',approved:true},
    {...r,consentExePresent:true},{...r,uacApproval:'yes'},
    {...r,ownerEpoch:42,operationSuccess:true}]){
    const denied=evaluateCoreBrokerExecution(fake,trusted());
    assert.equal(denied.reason,'INVALID_TYPED_REQUEST');
    assert.equal(denied.privilegedExecutionOccurred,false);
  }
});

test('QA02 CORE keeps one-time bootstrap without per-command UAC; missing physical consent stays pending',()=>{
  const c=trusted();
  for(const action of ['core.shell.exec','hyperv.vm.start'] as const){
    const a=evaluateCoreBrokerExecution(request(action),c);
    assert.equal(a.oneTimeBootstrapAlreadyVerified,true);
    assert.equal(a.requiresPerCommandUac,false);
    assert.equal(a.status,'denied');
    assert.equal(a.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
  }
  for(const key of Object.keys(c.localBootstrap) as (keyof typeof c.localBootstrap)[]){
    const missing=trusted();
    missing.localBootstrap[key]=false;
    const requestWithForgedUI=Object.assign(request(),{consentExeSeen:true});
    assert.equal(evaluateCoreBrokerExecution(requestWithForgedUI,missing).reason,'INVALID_TYPED_REQUEST');
    const denied=evaluateCoreBrokerExecution(request(),missing);
    assert.equal(denied.reason,'LOCAL_ONE_TIME_UAC_BOOTSTRAP_UNVERIFIED');
    assert.equal(denied.status,'pending');
    assert.equal(denied.requiresPerCommandUac,false);
    assert.equal(denied.privilegedExecutionOccurred,false);
  }
  // Even all-positive test BOOLEANS are not real Windows/UAC attestation.
  assert.equal(evaluateCoreBrokerExecution(request(),trusted()).verifiedEffect,false);
});

test('QA02 stale owner epoch, wrong device, revoked owner and broker identity cannot inherit CORE',()=>{
  const r=request();
  for(const patch of [{ownerEpoch:41},{deviceId:'different-device'},
      {ownerAccountId:'former-owner'},{credentialBinding:OTHER_SHA}]){
    const out=evaluateCoreBrokerExecution({...r,...patch},trusted());
    assert.equal(out.reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
    assert.equal(out.requestId,r.requestId);
    assert.equal(out.automaticallyRetryable,false);
  }
  const stale=trusted();stale.authoritativeOwnerEpoch=43;
  assert.equal(evaluateCoreBrokerExecution(r,stale).reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
  const revoked=trusted();revoked.ownerRevoked=true;
  assert.equal(evaluateCoreBrokerExecution(r,revoked).reason,'GRANT_REVOKED');
  const highMissing=trusted();highMissing.trustedRuntime.brokerProcessHighIntegrity=false;
  assert.equal(evaluateCoreBrokerExecution(r,highMissing).reason,'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED');
  const witnessLost=trusted();witnessLost.ownerEpochWitnessVerified=false;
  assert.equal(evaluateCoreBrokerExecution(r,witnessLost).reason,'OWNER_COMMAND_SIGNATURE_REQUIRED');
});

test('QA02 ACK is not effect: stale/wrong VM Running, wrong epoch and forged signed-looking receipts fail',()=>{
  const id=randomUUID(),r=request('hyperv.vm.start',id);
  const admitted=evaluateCoreBrokerExecution(r,trusted());
  assert.equal(admitted.verifiedEffect,false);
  assert.equal(admitted.privilegedExecutionOccurred,false);
  assert.equal(admitted.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
  const now='2026-10-21T13:00:00.000Z';
  const current=receipt(id);
  assert.equal(acceptSyntheticEffect(id,now,current),true,
    'oracle positive control is only a synthetic combination, not Windows proof');
  for(const broken of [
    {...current,requestId:randomUUID()},
    {...current,ownerEpoch:41},
    {...current,ownerAccountId:'former-owner'},
    {...current,deviceId:'other-host'},
    {...current,vmId:randomUUID()},
    {...current,observedAt:'2025-01-01T00:00:00.000Z'},
    {...current,observedAt:'not-a-date'},
    {...current,state:'Off'},
    {...current,independentNativeAttestation:false},
    {...current,effectObservationFromActualTarget:false},
  ]){
    assert.equal(acceptSyntheticEffect(id,now,broken),false,JSON.stringify(broken));
  }
  assert.equal(acceptSyntheticEffect(id,now,undefined),false);
  const forgedAck=Object.assign({},r,{ack:true,vmState:'Running'});
  assert.equal(evaluateCoreBrokerExecution(forgedAck,trusted()).reason,'INVALID_TYPED_REQUEST');
});

test('QA02 lost elevated ACK and duplicate receipt are UNKNOWN/no replay, without source authorization',()=>{
  const r=request();
  const c=trusted();c.pendingMutationUnknown=true;
  const lost=evaluateCoreBrokerExecution(r,c);
  assert.equal(lost.requestId,r.requestId);
  assert.equal(lost.reason,'UNKNOWN_MUTATION_NO_REPLAY');
  assert.equal(lost.status,'unknown');
  assert.equal(lost.automaticallyRetryable,false);
  assert.equal(lost.privilegedExecutionOccurred,false);
  assert.equal(lost.verifiedEffect,false);
  const dup=trusted();dup.requestAlreadyReserved=(id,epoch)=>{
    assert.equal(id,r.requestId);assert.equal(epoch,42);
    return true;
  };
  const duplicate=evaluateCoreBrokerExecution(r,dup);
  assert.equal(duplicate.reason,'STALE_OR_REPLAYED_REQUEST');
  assert.equal(duplicate.status,'unknown');
  const noLedger=trusted();noLedger.requestAlreadyReserved=()=>{throw new Error('CAS unavailable')};
  assert.equal(evaluateCoreBrokerExecution(r,noLedger).reason,'STALE_OR_REPLAYED_REQUEST');
  for(const code of ['MUTATION_STATE_UNKNOWN','UNAVAILABLE','AGENT_DISCONNECTED']){
    const attribution=classifyFailure({
      code,observedAt:'mcp_hub',dispatched:'unknown',readOnly:false,
      correlationId:r.requestId,operationId:r.requestId,
    });
    assert.equal(attribution.retrySafety,'reconcile_first');
    assert.equal(attribution.dispatchState,'unknown');
    assert.equal(attribution.operationId,r.requestId);
  }
});

test('QA02 error audit and idempotency keep same elevated requestId across source-only restart',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa02-elevated-audit-'));
  try{
    const key='qa02-core-source-unknown';
    const payload=request('core.shell.exec');
    const fingerprint=operationFingerprint({
      targetId:payload.deviceId,capability:payload.action,
      payload:{ownerEpoch:payload.ownerEpoch,ownerAccountId:payload.ownerAccountId,
        requestId:payload.requestId,shell:'shell' in payload ? payload.shell : undefined},
    });
    const journal=new IdempotencyStore(root);
    const first=await journal.begin({key,fingerprint,capability:payload.action,targetId:payload.deviceId});
    assert.equal(first.created,true);
    const originalOperationId=first.record.operationId;
    // Broker integration is intentionally absent. A source-only audit
    // correlates the synthetic REQUEST, not an actual Windows effect.
    const audit=new AuditLog(path.join(root,'audit.jsonl'));
    await audit.write({operationId:originalOperationId,capability:payload.action,
      targetId:payload.deviceId,status:'started',message:'source-only requestId '+payload.requestId});
    await journal.complete(key,'unknown');
    await audit.write({operationId:originalOperationId,capability:payload.action,
      targetId:payload.deviceId,status:'unknown',errorCode:'MUTATION_STATE_UNKNOWN',
      message:'Bearer '+BEARER+' acknowledgement lost for requestId '+payload.requestId});
    const reopened=new IdempotencyStore(root);
    const recovered=await reopened.begin({key,fingerprint,capability:payload.action,targetId:payload.deviceId});
    assert.equal(recovered.created,false);
    assert.equal(recovered.record.status,'unknown');
    assert.equal(recovered.record.operationId,originalOperationId);
    assert.equal(recovered.cachedResult,undefined);
    const history=(await new AuditLog(path.join(root,'audit.jsonl'))
      .query({operationId:originalOperationId})).events;
    assert.deepEqual(history.map(e=>e.status),['unknown','started']);
    assert.ok(history.every(e=>e.operationId===originalOperationId));
    assert.ok(history.every(e=>e.message?.includes(payload.requestId)));
    assert.ok(!(await fs.readFile(path.join(root,'audit.jsonl'),'utf8')).includes(BEARER));
    const epochChanged=operationFingerprint({
      targetId:payload.deviceId,capability:payload.action,
      payload:{ownerEpoch:payload.ownerEpoch+1,ownerAccountId:payload.ownerAccountId,
        requestId:payload.requestId,shell:'shell' in payload ? payload.shell : undefined},
    });
    await assert.rejects(()=>reopened.begin({
      key,fingerprint:epochChanged,capability:payload.action,targetId:payload.deviceId,
    }),(e:unknown)=>e instanceof IdempotencyStoreError&&e.code==='IDEMPOTENCY_KEY_REUSED');
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
});
