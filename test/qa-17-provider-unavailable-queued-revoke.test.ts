import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  evaluateCoreBrokerExecution,
  type CoreBrokerContext,
} from '../src/security/core-broker-executor-contract.js';

/**
 * Independent QA #17 continuation for #617.
 * This test-only adapter is NOT an installed Windows native attestor.
 * It translates synthetic #632-shaped observations into #633's source gate.
 * Missing/forged Windows evidence must never become a successful elevation.
 */
const A='a'.repeat(64);
const B='b'.repeat(64);
const NOW='2026-10-21T13:00:00.000Z';
const UUID='00000000-0000-4000-8000-000000000017';
const ACTIONS=[
  'core.shell.exec',
  'core.process.start',
  'core.process.stop',
  'hyperv.vm.status',
  'hyperv.vm.start',
  'hyperv.vm.stop',
] as const;

type Status='VERIFIED'|'INVALID'|'UNAVAILABLE';
type NativeProbe={
  provenance:'independent-windows-native'|'unverified';
  publisher:{status:Status;matchesOutOfBandPinnedCertificate:boolean};
  acl:{
    status:Status;
    brokerAndAncestorsProtected:boolean;
    importsAndUpdaterProtected:boolean;
    broadWriteGrantFound:boolean|null;
  };
  token:{
    status:Status;
    provider:'trusted-win32-token'|'broker-self-report';
    effectiveIntegrityRid:number|null;
    tokenIsElevated:boolean;
    administratorsEnabled:boolean;
    administratorsDenyOnly:boolean;
    taskPrincipalSid:string;
    taskRunLevel:'highest'|'least'|'unknown';
  };
  running:{
    status:Status;
    imageSha256:string;
    pinnedImageSha256:string;
    processCreationIdentityVerified:boolean;
    nativeImageHandleVerified:boolean;
    brokerVersionAuthenticated:boolean;
    duplicateHandleBoundaryProtected:boolean;
    signedReleaseAndRollbackVerified:boolean;
  };
};
function nativeFixture():NativeProbe {
  return {
    provenance:'independent-windows-native',
    publisher:{status:'VERIFIED',matchesOutOfBandPinnedCertificate:true},
    acl:{
      status:'VERIFIED',
      brokerAndAncestorsProtected:true,
      importsAndUpdaterProtected:true,
      broadWriteGrantFound:false,
    },
    token:{
      status:'VERIFIED',provider:'trusted-win32-token',
      effectiveIntegrityRid:0x3000,tokenIsElevated:true,
      administratorsEnabled:true,administratorsDenyOnly:false,
      taskPrincipalSid:'S-1-5-18',taskRunLevel:'highest',
    },
    running:{
      status:'VERIFIED',imageSha256:A,pinnedImageSha256:A,
      processCreationIdentityVerified:true,nativeImageHandleVerified:true,
      brokerVersionAuthenticated:true,duplicateHandleBoundaryProtected:true,
      signedReleaseAndRollbackVerified:true,
    },
  };
}
function context(mode:'CORE'|'ROOT'='CORE'):CoreBrokerContext {
  return {
    now:new Date(NOW),ownerAccountId:'owner-17',deviceId:'device-17',
    credentialBinding:A,authoritativeOwnerEpoch:31,ownerRevoked:false,
    enrollment:{
      deviceId:'device-17',ownerAccountId:'owner-17',
      ownerEpoch:31,credentialBinding:A,
      enrollmentId:'00000000-0000-4000-8000-000000000018',
      mode,activatedAt:'2026-10-21T12:55:00.000Z',
      expiresAt:mode==='ROOT'?'2026-10-21T13:10:00.000Z':null,
      ownerSignedGrantDigest:B,brokerInstalledImageSha256:A,
    },
    localBootstrap:{
      localPhysicalUacConsentVerified:true,
      signedEnrollmentStoredInProtectedBroker:true,
      trustedInstallerRollbackBindingVerified:true,
    },
    trustedRuntime:{
      evidenceProvenance:'unverified',
      brokerProcessHighIntegrity:false,
      administratorsTokenEnabled:false,
      brokerAuthenticatedAndVersionMatched:false,
      runningImageIdentityMatched:false,
      expectedBrokerImageSha256:A,
      imageAuthenticodePublisherPinned:false,
      signedReleaseAndRollbackManifestVerified:false,
      brokerExeAndParentAclProtected:false,
      importedModulesAclProtected:false,
      updaterPathsAclProtected:false,
      processHandleDuplicationBoundaryProtected:false,
    },
    ownerIntentSignatureVerified:true,enrollmentSignatureVerified:true,
    ownerEpochWitnessVerified:true,
    requestAlreadyReserved:()=>false,
    pendingMutationUnknown:false,
    approvedVmIds:['2eb71c03-a5f2-4f16-bbbf-c0d29ee2a791'],
    stopProcessIdentityVerified:true,
  };
}
function request(action:typeof ACTIONS[number]='core.shell.exec',mode:'CORE'|'ROOT'='CORE') {
  return {
    type:'core-broker.execute',version:1,requestId:UUID,
    ownerAccountId:'owner-17',deviceId:'device-17',ownerEpoch:31,
    credentialBinding:A,mode,action,
    issuedAt:'2026-10-21T12:59:40.000Z',
    expiresAt:'2026-10-21T13:00:20.000Z',
    ...(action==='core.shell.exec'||action==='core.process.start'
      ? {shell:{executable:'C:\\Windows\\System32\\whoami.exe',arguments:[]}}:{}),
    ...(action==='core.process.stop'
      ? {stopTarget:{pid:1204,processCreationFiletime:'133000000000000000',expectedImageSha256:A}}:{}),
    ...(action.startsWith('hyperv.vm.')
      ? {vmId:'2eb71c03-a5f2-4f16-bbbf-c0d29ee2a791'}:{}),
  };
}
function gateFromProbe(probe:NativeProbe,mode:'CORE'|'ROOT'='CORE'):CoreBrokerContext {
  const c=context(mode);
  const t=c.trustedRuntime;
  const token=probe.token;
  const runtime=probe.running;
  const acl=probe.acl;
  const high=token.status==='VERIFIED' &&
    token.provider==='trusted-win32-token' &&
    token.tokenIsElevated===true &&
    Number.isSafeInteger(token.effectiveIntegrityRid) &&
    (token.effectiveIntegrityRid??0)>=0x3000 &&
    token.administratorsEnabled===true &&
    token.administratorsDenyOnly===false &&
    token.taskPrincipalSid==='S-1-5-18' &&
    token.taskRunLevel==='highest';
  const image=runtime.status==='VERIFIED' &&
    runtime.nativeImageHandleVerified &&
    runtime.processCreationIdentityVerified &&
    runtime.imageSha256===runtime.pinnedImageSha256 &&
    runtime.imageSha256===A;
  const aclClean=acl.status==='VERIFIED' &&
    acl.broadWriteGrantFound===false;
  t.evidenceProvenance=probe.provenance;
  t.brokerProcessHighIntegrity=high;
  t.administratorsTokenEnabled=high;
  t.brokerAuthenticatedAndVersionMatched=high && runtime.status==='VERIFIED' &&
    runtime.brokerVersionAuthenticated;
  t.runningImageIdentityMatched=image;
  t.imageAuthenticodePublisherPinned=probe.publisher.status==='VERIFIED' &&
    probe.publisher.matchesOutOfBandPinnedCertificate;
  t.signedReleaseAndRollbackManifestVerified=
    runtime.status==='VERIFIED' && runtime.signedReleaseAndRollbackVerified;
  t.brokerExeAndParentAclProtected=aclClean && acl.brokerAndAncestorsProtected;
  t.importedModulesAclProtected=aclClean && acl.importsAndUpdaterProtected;
  t.updaterPathsAclProtected=aclClean && acl.importsAndUpdaterProtected;
  t.processHandleDuplicationBoundaryProtected=runtime.status==='VERIFIED' &&
    runtime.duplicateHandleBoundaryProtected;
  return c;
}
function assertNoPrivilege(result:ReturnType<typeof evaluateCoreBrokerExecution>) {
  assert.equal(result.privilegedExecutionOccurred,false);
  assert.equal(result.verifiedEffect,false);
  assert.equal(result.automaticallyRetryable,false);
  assert.equal(result.requiresPerCommandUac,false);
  assert.notEqual(result.status,'succeeded');
}

test('#17 provider UNAVAILABLE never means pinned publisher, or no broad ACL write grant',()=>{
  const variants:Array<{name:string;change:(x:NativeProbe)=>void}>=[
    {name:'Authenticode provider unavailable',change:x=>{
      x.publisher.status='UNAVAILABLE';
    }},
    {name:'Signer invalid but certificate thumbprint matches',change:x=>{
      x.publisher.status='INVALID';
    }},
    {name:'Missing independently pinned publisher',change:x=>{
      x.publisher.matchesOutOfBandPinnedCertificate=false;
    }},
    {name:'ACL provider unavailable with broadWriteGrantFound null',change:x=>{
      x.acl.status='UNAVAILABLE';x.acl.broadWriteGrantFound=null;
    }},
    {name:'ACL provider unavailable yet caller claims no unsafe ACE',change:x=>{
      x.acl.status='UNAVAILABLE';x.acl.broadWriteGrantFound=false;
    }},
    {name:'Parent directory writable despite file ACL protected',change:x=>{
      x.acl.brokerAndAncestorsProtected=false;
    }},
    {name:'Updaters/imports omitted',change:x=>{
      x.acl.importsAndUpdaterProtected=false;
    }},
    {name:'Inherited Authenticated Users Modify',change:x=>{
      x.acl.broadWriteGrantFound=true;
    }},
    {name:'No independent native evidence provider',change:x=>{
      x.provenance='unverified';
    }},
  ];
  for(const {name,change} of variants){
    const p=nativeFixture();change(p);
    for(const action of ACTIONS){
      const out=evaluateCoreBrokerExecution(request(action),gateFromProbe(p));
      assert.equal(out.reason,'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED',
        name+' / '+action);
      assertNoPrivilege(out);
    }
  }
});

test('#17 effective Windows high-token is NOT a task name, PID, high label or broker self-report',()=>{
  const variants:Array<{name:string;change:(x:NativeProbe)=>void}>=[
    {name:'TokenInformation provider unavailable',change:x=>{x.token.status='UNAVAILABLE'}},
    {name:'Medium integrity',change:x=>{x.token.effectiveIntegrityRid=0x2000}},
    {name:'No TokenElevation',change:x=>{x.token.tokenIsElevated=false}},
    {name:'Administrators deny-only',change:x=>{x.token.administratorsDenyOnly=true}},
    {name:'Administrators disabled',change:x=>{x.token.administratorsEnabled=false}},
    {name:'Wrong service principal',change:x=>{x.token.taskPrincipalSid='S-1-5-11'}},
    {name:'Task least run-level',change:x=>{x.token.taskRunLevel='least'}},
    {name:'Broker claimed high token',change:x=>{x.token.provider='broker-self-report'}},
    {name:'Missing integrity RID',change:x=>{x.token.effectiveIntegrityRid=null}},
    {name:'Invalid fractional RID',change:x=>{x.token.effectiveIntegrityRid=0x3000+0.5}},
    {name:'Stale image creation identity',change:x=>{x.running.processCreationIdentityVerified=false}},
    {name:'No native running image handle',change:x=>{x.running.nativeImageHandleVerified=false}},
    {name:'Different running image',change:x=>{x.running.imageSha256=B}},
    {name:'Unversioned Broker health',change:x=>{x.running.brokerVersionAuthenticated=false}},
    {name:'Untrusted PROCESS_DUP_HANDLE boundary',change:x=>{x.running.duplicateHandleBoundaryProtected=false}},
    {name:'Unsigned recovery/rollback',change:x=>{x.running.signedReleaseAndRollbackVerified=false}},
  ];
  for(const {name,change} of variants){
    const p=nativeFixture();change(p);
    const out=evaluateCoreBrokerExecution(request(),gateFromProbe(p));
    assert.equal(out.reason,'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED',name);
    assertNoPrivilege(out);
  }
});

test('#17 all-green synthetic high token evidence still means dispatch NOT INSTALLED',()=>{
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  for(const action of ACTIONS)for(const mode of ['CORE','ROOT'] as const){
    const out=evaluateCoreBrokerExecution(request(action,mode),gateFromProbe(nativeFixture(),mode));
    assert.equal(out.reason,'ELEVATED_DISPATCH_NOT_INSTALLED',action+' / '+mode);
    assertNoPrivilege(out);
  }
});

test('#17 queued owner delegation revoked before drain denies across all actions and both modes',()=>{
  for(const action of ACTIONS)for(const mode of ['CORE','ROOT'] as const){
    const c=gateFromProbe(nativeFixture(),mode);
    const pending=request(action,mode);
    // Queue insertion is a pure fixture, not a Broker queue or command execution.
    const queue=[pending];
    const preflight=evaluateCoreBrokerExecution(queue[0],c);
    assert.equal(preflight.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
    c.ownerRevoked=true;
    const atDrain=evaluateCoreBrokerExecution(queue.shift(),c);
    assert.equal(atDrain.reason,'GRANT_REVOKED',action+' / '+mode);
    assertNoPrivilege(atDrain);
  }
});

test('#17 owner re-pair changes external epoch, even if queued request had a formerly valid signature',()=>{
  for(const mode of ['CORE','ROOT'] as const){
    const c=gateFromProbe(nativeFixture(),mode);
    const pending=request('core.shell.exec',mode);
    c.authoritativeOwnerEpoch=32;
    c.credentialBinding=B;
    c.ownerAccountId='new-owner';
    // Re-pair must invalidate the old owner/device/credential/epoch identity.
    const atDrain=evaluateCoreBrokerExecution(pending,c);
    assert.equal(atDrain.reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
    assertNoPrivilege(atDrain);
  }
});

test('#17 ROOT queued during valid enrollment cannot drain at its 15-minute expiry',()=>{
  const c=gateFromProbe(nativeFixture(),'ROOT');
  const pending={
    ...request('core.shell.exec','ROOT'),
    issuedAt:'2026-10-21T13:09:59.000Z',
    expiresAt:'2026-10-21T13:10:01.000Z',
  };
  c.now=new Date('2026-10-21T13:09:59.000Z');
  assert.equal(evaluateCoreBrokerExecution(pending,c).reason,'ROOT_15_MINUTES_EXCEEDED',
    'request expiry after ROOT deadline is forbidden before queueing');
  const valid={...pending,expiresAt:'2026-10-21T13:10:00.000Z'};
  assert.equal(evaluateCoreBrokerExecution(valid,c).reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
  c.now=new Date('2026-10-21T13:10:00.000Z');
  const atDrain=evaluateCoreBrokerExecution(valid,c);
  assert.equal(atDrain.reason,'GRANT_NOT_ACTIVE');
  assertNoPrivilege(atDrain);
});

test('#17 revocation racing during replay-ledger lookup exposes pre-dispatch recheck requirement',()=>{
  const c=gateFromProbe(nativeFixture());
  c.requestAlreadyReserved=()=>{
    // Atomic source test: simulates external owner revocation as the ledger is queried.
    c.ownerRevoked=true;
    c.authoritativeOwnerEpoch=32;
    return false;
  };
  const stale=evaluateCoreBrokerExecution(request(),c);
  // Current #633 gate checks owner epoch BEFORE querying the durable ledger.
  // This is NOT an approval. Dispatch remains disabled; a future real executor
  // MUST recheck independent owner epoch after reservation and before dispatch.
  assert.equal(stale.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
  assertNoPrivilege(stale);
  const recheck=evaluateCoreBrokerExecution(request(),c);
  assert.equal(recheck.reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
  assertNoPrivilege(recheck);
});

test('#17 broker unavailable, UNKNOWN ACK and duplicate reservation never replay queued command',()=>{
  const variants:Array<{reason:string;change:(x:CoreBrokerContext)=>void}>=[
    {reason:'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED',change:x=>{
      x.trustedRuntime.brokerAuthenticatedAndVersionMatched=false;
    }},
    {reason:'UNKNOWN_MUTATION_NO_REPLAY',change:x=>{x.pendingMutationUnknown=true}},
    {reason:'STALE_OR_REPLAYED_REQUEST',change:x=>{x.requestAlreadyReserved=()=>true}},
  ];
  for(const {reason,change} of variants){
    const c=gateFromProbe(nativeFixture());change(c);
    const out=evaluateCoreBrokerExecution(request(),c);
    assert.equal(out.reason,reason);
    assertNoPrivilege(out);
  }
});
