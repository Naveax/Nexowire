import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  evaluateCoreBrokerExecution,
  type CoreBrokerContext,
} from '../src/security/core-broker-executor-contract.js';
import { IdempotencyStore, IdempotencyStoreError, operationFingerprint } from '../src/operations/idempotency-store.js';
import { AuditLog } from '../src/audit/log.js';
import { classifyFailure } from '../src/protocol/error-contract-v2.js';

const SHA='a'.repeat(64), OTHER='b'.repeat(64);
const DEVICE='qa02-device-670', OWNER='qa02-owner-670';
const VM_ID='b3ce8e05-dbc3-4b53-a490-e23e46191952';
const CLOCK=new Date('2026-10-21T17:00:00.000Z');
const SECRET='Qa02BearerNeverPersist170A';
const request=(action:'core.shell.exec'|'hyperv.vm.start'='core.shell.exec', id=randomUUID())=>({
  type:'core-broker.execute' as const,version:1 as const,
  requestId:id,deviceId:DEVICE,ownerAccountId:OWNER,ownerEpoch:70,
  credentialBinding:SHA,mode:'CORE' as const,action,
  issuedAt:'2026-10-21T16:59:40.000Z',
  expiresAt:'2026-10-21T17:00:20.000Z',
  ...(action==='core.shell.exec'?
    {shell:{executable:'C:\\Windows\\System32\\cmd.exe',arguments:['/C','echo NO_EXECUTION']}}:
    {vmId:VM_ID}),
});
function ctx():CoreBrokerContext {
  return {
    now:new Date(CLOCK),deviceId:DEVICE,ownerAccountId:OWNER,
    credentialBinding:SHA,authoritativeOwnerEpoch:70,ownerRevoked:false,
    enrollment:{deviceId:DEVICE,ownerAccountId:OWNER,credentialBinding:SHA,
      ownerEpoch:70,enrollmentId:randomUUID(),mode:'CORE',
      activatedAt:'2026-10-21T16:55:00.000Z',expiresAt:null,
      ownerSignedGrantDigest:OTHER,brokerInstalledImageSha256:SHA},
    localBootstrap:{
      localPhysicalUacConsentVerified:true,
      signedEnrollmentStoredInProtectedBroker:true,
      trustedInstallerRollbackBindingVerified:true,
    },
    trustedRuntime:{
      evidenceProvenance:'independent-windows-native',
      brokerProcessHighIntegrity:true,administratorsTokenEnabled:true,
      brokerAuthenticatedAndVersionMatched:true,runningImageIdentityMatched:true,
      expectedBrokerImageSha256:SHA,imageAuthenticodePublisherPinned:true,
      signedReleaseAndRollbackManifestVerified:true,brokerExeAndParentAclProtected:true,
      importedModulesAclProtected:true,updaterPathsAclProtected:true,
      processHandleDuplicationBoundaryProtected:true,
    },
    ownerIntentSignatureVerified:true,enrollmentSignatureVerified:true,
    ownerEpochWitnessVerified:true,requestAlreadyReserved:()=>false,
    pendingMutationUnknown:false,approvedVmIds:[VM_ID],
    stopProcessIdentityVerified:true,
  };
}

test('QA02 #670 native provider source measures ONLY current test PowerShell token, never installed Broker',async()=>{
  const source=await fs.readFile(path.resolve('scripts/audit-windows-broker-token-provider.ps1'),'utf8');
  assert.match(source,/GetCurrentProcess\(\)/,'token query must be scoped to inspecting process');
  assert.match(source,/GetTokenInformation\(\$token,25/);
  assert.match(source,/GetTokenInformation\(\$token,20/);
  for(const field of [
    'brokerProcessPidAttested','brokerProcessImageIdentityAttested',
    'brokerOwnerDeviceEpochAttested','protectedBrokerImportTreeAttested',
    'trustedSignedReleaseManifestAttested','highTokenBrokerIdentityAttested',
    'elevatedCoreDispatchEnabled','productionReady',
  ]){
    assert.match(source,new RegExp('\\b'+field+'=\\$false\\b'),
      'provider cannot assert installed Broker truth from its own process token: '+field);
  }
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
});

test('QA02 #670 token witness missing or own-process high token never elevates an unauthenticated Broker',()=>{
  const req=request(),noWitness=ctx();
  noWitness.trustedRuntime.evidenceProvenance='unverified';
  noWitness.trustedRuntime.brokerProcessHighIntegrity=false;
  noWitness.trustedRuntime.administratorsTokenEnabled=false;
  noWitness.trustedRuntime.brokerAuthenticatedAndVersionMatched=false;
  const denied=evaluateCoreBrokerExecution(req,noWitness);
  assert.equal(denied.reason,'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED');
  assert.equal(denied.requestId,req.requestId);
  assert.equal(denied.verifiedEffect,false);
  assert.equal(denied.automaticallyRetryable,false);
  const onlyTestToken=ctx();
  // A hosted test process can be High, but it is not the running installed Broker.
  onlyTestToken.trustedRuntime.runningImageIdentityMatched=false;
  onlyTestToken.trustedRuntime.brokerAuthenticatedAndVersionMatched=false;
  onlyTestToken.trustedRuntime.processHandleDuplicationBoundaryProtected=false;
  assert.equal(evaluateCoreBrokerExecution(req,onlyTestToken).reason,
    'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED');
});

test('QA02 #670 forged physical UAC approval never satisfies initial bootstrap while verified signed CORE has no per-command UAC',()=>{
  const original=request();
  for(const extra of [{approved:true},{consentExePresent:true},
    {uacClicked:true},{physicalUacApproved:true},{transportOk:true}]){
    const malformed=evaluateCoreBrokerExecution({...original,...extra},ctx());
    assert.equal(malformed.reason,'INVALID_TYPED_REQUEST');
    assert.equal(malformed.privilegedExecutionOccurred,false);
  }
  const noInitial=ctx();
  noInitial.localBootstrap.localPhysicalUacConsentVerified=false;
  const missing=evaluateCoreBrokerExecution(original,noInitial);
  assert.equal(missing.reason,'LOCAL_ONE_TIME_UAC_BOOTSTRAP_UNVERIFIED');
  assert.equal(missing.status,'pending');
  assert.equal(missing.requiresPerCommandUac,false);
  assert.equal(missing.oneTimeBootstrapAlreadyVerified,false);
  const enrolled=evaluateCoreBrokerExecution(original,ctx());
  assert.equal(enrolled.oneTimeBootstrapAlreadyVerified,true);
  assert.equal(enrolled.requiresPerCommandUac,false);
  assert.equal(enrolled.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
  assert.equal(enrolled.privilegedExecutionOccurred,false);
  assert.equal(enrolled.verifiedEffect,false);
});

test('QA02 #670 stale CORE epoch or revoked owner denies despite forged token, cached approval and high broker flags',()=>{
  const req=request();
  for(const ownerEpoch of [69,71]){
    const out=evaluateCoreBrokerExecution({...req,ownerEpoch},ctx());
    assert.equal(out.reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
    assert.equal(out.requestId,req.requestId);
    assert.equal(out.automaticallyRetryable,false);
  }
  const staleWitness=ctx();staleWitness.authoritativeOwnerEpoch=71;
  assert.equal(evaluateCoreBrokerExecution(req,staleWitness).reason,
    'WRONG_DEVICE_OR_OWNER_EPOCH');
  const revoked=ctx();revoked.ownerRevoked=true;
  assert.equal(evaluateCoreBrokerExecution(req,revoked).reason,'GRANT_REVOKED');
  const missingEpoch=ctx();missingEpoch.ownerEpochWitnessVerified=false;
  assert.equal(evaluateCoreBrokerExecution(req,missingEpoch).reason,
    'OWNER_COMMAND_SIGNATURE_REQUIRED');
});

interface SyntheticVmObservation {
  requestId:string;deviceId:string;ownerAccountId:string;ownerEpoch:number;
  vmId:string;state:string;observedAt:string;nativeBrokerIdentityVerified:boolean;
  targetBoundAndIndependent:boolean;
}
function acceptsSyntheticReadback(requestId:string,issuedAt:string,obs:SyntheticVmObservation|undefined) {
  if(!obs||!obs.nativeBrokerIdentityVerified||!obs.targetBoundAndIndependent)return false;
  const seen=Date.parse(obs.observedAt),issued=Date.parse(issuedAt);
  return Number.isFinite(seen)&&seen>issued&&
    obs.requestId===requestId&&obs.deviceId===DEVICE&&
    obs.ownerAccountId===OWNER&&obs.ownerEpoch===70&&
    obs.vmId===VM_ID&&obs.state==='Running';
}
test('QA02 #670 ACK/exit zero/stale Running cannot substitute for request-bound independent VM postcondition',()=>{
  const req=request('hyperv.vm.start');
  const ack=evaluateCoreBrokerExecution(req,ctx());
  assert.equal(ack.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
  assert.equal(ack.verifiedEffect,false);
  const synthetic:SyntheticVmObservation={
    requestId:req.requestId,deviceId:DEVICE,ownerAccountId:OWNER,
    ownerEpoch:70,vmId:VM_ID,state:'Running',
    observedAt:'2026-10-21T17:00:05.000Z',
    nativeBrokerIdentityVerified:true,targetBoundAndIndependent:true,
  };
  // This is a pure, synthetic oracle only. No real VM is read or started.
  assert.equal(acceptsSyntheticReadback(req.requestId,req.issuedAt,synthetic),true);
  for(const wrong of [
    {...synthetic,requestId:randomUUID()},
    {...synthetic,deviceId:'foreign-device'},
    {...synthetic,ownerAccountId:'previous-owner'},
    {...synthetic,ownerEpoch:69},
    {...synthetic,vmId:randomUUID()},
    {...synthetic,state:'Off'},
    {...synthetic,observedAt:'2025-01-01T00:00:00.000Z'},
    {...synthetic,observedAt:'bad timestamp'},
    {...synthetic,nativeBrokerIdentityVerified:false},
    {...synthetic,targetBoundAndIndependent:false},
  ]) assert.equal(acceptsSyntheticReadback(req.requestId,req.issuedAt,wrong),false);
  const fakeAck=evaluateCoreBrokerExecution({...req,ack:true,vmState:'Running'},ctx());
  assert.equal(fakeAck.reason,'INVALID_TYPED_REQUEST');
  assert.equal(ack.automaticallyRetryable,false);
});

test('QA02 #670 crash before durable completion upgrades in_progress to persistent UNKNOWN with original requestId and no replay',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa02-670-unknown-crash-'));
  try {
    const command=request(),key='qa02-670-core-crash';
    const fingerprintFor=(ownerEpoch:number)=>operationFingerprint({
      targetId:DEVICE,capability:command.action,
      payload:{ownerEpoch,ownerAccountId:OWNER,
        credentialBinding:SHA,requestId:command.requestId},
    });
    const first=new IdempotencyStore(dir);
    const reserved=await first.begin({
      key,fingerprint:fingerprintFor(70),capability:command.action,targetId:DEVICE,
    });
    assert.equal(reserved.created,true);
    assert.equal(reserved.record.status,'in_progress');
    const operationId=reserved.record.operationId;
    const auditFile=path.join(dir,'audit.jsonl'),audit=new AuditLog(auditFile);
    await audit.write({
      operationId,capability:command.action,status:'started',targetId:DEVICE,
      message:'requestId '+command.requestId,
    });
    // Deliberately abandon the FIRST journal object without complete().
    // Re-instantiation simulates a crash after a possible dispatch.
    const restarted=new IdempotencyStore(dir);
    const recovered=await restarted.begin({
      key,fingerprint:fingerprintFor(70),capability:command.action,targetId:DEVICE,
    });
    assert.equal(recovered.created,false);
    assert.equal(recovered.record.status,'unknown');
    assert.equal(recovered.record.operationId,operationId);
    assert.equal(recovered.cachedResult,undefined);
    await audit.write({
      operationId,capability:command.action,status:'unknown',targetId:DEVICE,
      errorCode:'MUTATION_STATE_UNKNOWN',
      message:'requestId '+command.requestId+' Bearer '+SECRET+' lost reply',
    });
    const events=(await new AuditLog(auditFile).query({operationId})).events;
    assert.deepEqual(events.map(x=>x.status),['unknown','started']);
    assert.ok(events.every(x=>x.operationId===operationId&&x.message?.includes(command.requestId)));
    assert.ok(!(await fs.readFile(auditFile,'utf8')).includes(SECRET));
    const again=new IdempotencyStore(dir);
    assert.equal((await again.getByOperationId(operationId))?.status,'unknown');
    const same=await again.begin({
      key,fingerprint:fingerprintFor(70),capability:command.action,targetId:DEVICE,
    });
    assert.equal(same.created,false);
    const changedEpoch=()=>again.begin({
      key,fingerprint:fingerprintFor(71),capability:command.action,targetId:DEVICE,
    });
    await assert.rejects(changedEpoch,(e:unknown)=>
      e instanceof IdempotencyStoreError&&e.code==='IDEMPOTENCY_KEY_REUSED');
    const block=ctx();block.pendingMutationUnknown=true;
    const result=evaluateCoreBrokerExecution(command,block);
    assert.equal(result.reason,'UNKNOWN_MUTATION_NO_REPLAY');
    assert.equal(result.status,'unknown');
    assert.equal(result.requestId,command.requestId);
    assert.equal(result.automaticallyRetryable,false);
    const failure=classifyFailure({
      code:'MUTATION_STATE_UNKNOWN',observedAt:'mcp_hub',
      dispatched:'unknown',readOnly:false,correlationId:command.requestId,
      operationId,
    });
    assert.equal(failure.retrySafety,'reconcile_first');
    assert.equal(failure.operationId,operationId);
    assert.equal(failure.correlationId,command.requestId);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
