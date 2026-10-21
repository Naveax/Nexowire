import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  evaluateCoreBrokerExecution,
  type CoreBrokerContext,
} from '../src/security/core-broker-executor-contract.js';
import {isPrivilegedBrokerCapability,privilegeRequirement} from '../src/security/privilege.js';

/** Independent #17 adversarial fixtures: not Windows token or UAC attestations. */
const H='a'.repeat(64),B='b'.repeat(64);
const VM='2eb71c03-a5f2-4f16-bbbf-c0d29ee2a791';
const CLOCK='2026-10-21T13:00:00.000Z';
const ACTIONS=[
  'core.shell.exec','core.process.start','core.process.stop',
  'hyperv.vm.status','hyperv.vm.start','hyperv.vm.stop',
] as const;
function request(action:string='core.shell.exec',mode:'CORE'|'ROOT'='CORE') {
  return {
    type:'core-broker.execute',version:1,
    requestId:'00000000-0000-4000-8000-000000000017',
    ownerAccountId:'owner-17',deviceId:'device-17',ownerEpoch:31,
    credentialBinding:H,mode,action,
    issuedAt:'2026-10-21T12:59:40.000Z',
    expiresAt:'2026-10-21T13:00:20.000Z',
    ...(action==='core.shell.exec'||action==='core.process.start'
      ? {shell:{executable:'C:\\Windows\\System32\\whoami.exe',arguments:[]}}:{}),
    ...(action==='core.process.stop'
      ? {stopTarget:{pid:4242,processCreationFiletime:'133000000000000000',
        expectedImageSha256:B}}:{}),
    ...(action.startsWith('hyperv.vm.')?{vmId:VM}:{}),
  };
}
function context(mode:'CORE'|'ROOT'='CORE'):CoreBrokerContext {
  return {
    now:new Date(CLOCK),ownerAccountId:'owner-17',deviceId:'device-17',
    credentialBinding:H,authoritativeOwnerEpoch:31,ownerRevoked:false,
    enrollment:{
      deviceId:'device-17',ownerAccountId:'owner-17',ownerEpoch:31,
      credentialBinding:H,enrollmentId:'00000000-0000-4000-8000-000000000018',
      activatedAt:'2026-10-21T12:55:00.000Z',mode,
      expiresAt:mode==='ROOT'?'2026-10-21T13:10:00.000Z':null,
      ownerSignedGrantDigest:B,brokerInstalledImageSha256:H,
    },
    localBootstrap:{
      localPhysicalUacConsentVerified:true,
      signedEnrollmentStoredInProtectedBroker:true,
      trustedInstallerRollbackBindingVerified:true,
    },
    trustedRuntime:{
      evidenceProvenance:'independent-windows-native',
      brokerProcessHighIntegrity:true,administratorsTokenEnabled:true,
      brokerAuthenticatedAndVersionMatched:true,runningImageIdentityMatched:true,
      expectedBrokerImageSha256:H,imageAuthenticodePublisherPinned:true,
      signedReleaseAndRollbackManifestVerified:true,
      brokerExeAndParentAclProtected:true,importedModulesAclProtected:true,
      updaterPathsAclProtected:true,
      processHandleDuplicationBoundaryProtected:true,
    },
    ownerIntentSignatureVerified:true,enrollmentSignatureVerified:true,
    ownerEpochWitnessVerified:true,
    requestAlreadyReserved:()=>false,pendingMutationUnknown:false,
    approvedVmIds:[VM],stopProcessIdentityVerified:true,
  };
}
const evaluate=(raw:unknown,c=context())=>evaluateCoreBrokerExecution(raw,c);
function neverExecuted(result:ReturnType<typeof evaluateCoreBrokerExecution>) {
  assert.equal(result.privilegedExecutionOccurred,false);
  assert.equal(result.verifiedEffect,false);
  assert.equal(result.automaticallyRetryable,false);
  assert.equal(result.requiresPerCommandUac,false);
}

test('#17 all six CORE/ROOT capabilities remain unreachable despite synthetic all-green attestations',()=>{
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  for(const mode of ['CORE','ROOT'] as const)for(const action of ACTIONS){
    const result=evaluate(request(action,mode),context(mode));
    assert.equal(privilegeRequirement(action,{}),'elevated',action);
    assert.equal(isPrivilegedBrokerCapability(action),false,action);
    assert.equal(result.reason,'ELEVATED_DISPATCH_NOT_INSTALLED',action);
    assert.equal(result.status,'denied');
    assert.equal(result.oneTimeBootstrapAlreadyVerified,true);
    neverExecuted(result);
  }
  assert.equal(isPrivilegedBrokerCapability('shell.exec'),false);
  assert.equal(privilegeRequirement('shell.exec',{}),'standard');
});

test('#17 each independent Windows/native attestation is mandatory for every executor class',()=>{
  const nativeBooleans=[
    'brokerProcessHighIntegrity','administratorsTokenEnabled',
    'brokerAuthenticatedAndVersionMatched','runningImageIdentityMatched',
    'imageAuthenticodePublisherPinned','signedReleaseAndRollbackManifestVerified',
    'brokerExeAndParentAclProtected','importedModulesAclProtected',
    'updaterPathsAclProtected','processHandleDuplicationBoundaryProtected',
  ] as const;
  for(const action of ACTIONS)for(const property of nativeBooleans){
    const c=context();
    c.trustedRuntime[property]=false;
    const result=evaluate(request(action),c);
    assert.equal(result.reason,'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED',
      action+' / '+property);
    neverExecuted(result);
  }
  for(const action of ACTIONS){
    const c=context();
    c.trustedRuntime.evidenceProvenance='unverified';
    assert.equal(evaluate(request(action),c).reason,
      'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED');
  }
});

test('#17 owner rotation, revocation and device/key swaps preempt an otherwise authorized ROOT/CORE',()=>{
  for(const mode of ['CORE','ROOT'] as const)for(const action of ACTIONS){
    const revoked=context(mode);revoked.ownerRevoked=true;
    assert.equal(evaluate(request(action,mode),revoked).reason,'GRANT_REVOKED');
    const rotated=context(mode);rotated.authoritativeOwnerEpoch=32;
    assert.equal(evaluate(request(action,mode),rotated).reason,
      'WRONG_DEVICE_OR_OWNER_EPOCH');
    for(const patch of [
      {ownerAccountId:'other-owner'},{deviceId:'other-device'},
      {credentialBinding:B},{ownerEpoch:30},
    ]){
      assert.equal(evaluate({...request(action,mode),...patch},context(mode)).reason,
        'WRONG_DEVICE_OR_OWNER_EPOCH');
    }
  }
});

test('#17 ROOT rejects 15m+1ms, exact end time and a replayed expired request',()=>{
  const tooLong=context('ROOT');
  tooLong.enrollment={...tooLong.enrollment!,
    expiresAt:'2026-10-21T13:10:00.001Z'};
  assert.equal(evaluate(request('core.shell.exec','ROOT'),tooLong).reason,
    'ROOT_15_MINUTES_EXCEEDED');
  const atBoundary=context('ROOT');
  atBoundary.now=new Date('2026-10-21T13:10:00.000Z');
  const fresh={...request('core.shell.exec','ROOT'),
    issuedAt:'2026-10-21T13:09:59.000Z',
    expiresAt:'2026-10-21T13:10:01.000Z'};
  assert.equal(evaluate(fresh,atBoundary).reason,'ROOT_15_MINUTES_EXCEEDED');
  const delayed=context('ROOT');
  delayed.now=new Date('2026-10-21T13:02:00.000Z');
  assert.equal(evaluate(request('core.shell.exec','ROOT'),delayed).reason,
    'GRANT_NOT_ACTIVE');
  const core=context();
  core.now=new Date('2028-10-21T13:00:00.000Z');
  const renewed={...request(),issuedAt:'2028-10-21T12:59:59.000Z',
    expiresAt:'2028-10-21T13:00:20.000Z'};
  assert.equal(evaluate(renewed,core).reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
  core.ownerRevoked=true;
  assert.equal(evaluate(renewed,core).reason,'GRANT_REVOKED');
});

test('#17 mutation ACK lost, durable ledger unavailable or replayed never schedules retry',()=>{
  for(const mode of ['CORE','ROOT'] as const)for(const action of ACTIONS){
    const unknown=context(mode);unknown.pendingMutationUnknown=true;
    const a=evaluate(request(action,mode),unknown);
    assert.equal(a.reason,'UNKNOWN_MUTATION_NO_REPLAY');
    assert.equal(a.status,'unknown');neverExecuted(a);
    const recorded=context(mode);recorded.requestAlreadyReserved=()=>true;
    const b=evaluate(request(action,mode),recorded);
    assert.equal(b.reason,'STALE_OR_REPLAYED_REQUEST');neverExecuted(b);
    const disconnected=context(mode);
    disconnected.requestAlreadyReserved=()=>{throw new Error('witness offline')};
    const d=evaluate(request(action,mode),disconnected);
    assert.equal(d.status,'unknown');neverExecuted(d);
  }
});

test('#17 target substitution, arbitrary UAC flags and PID-only process stops fail typed validation',()=>{
  const malformed=[
    {...request('core.shell.exec'),approved:true},
    {...request('core.shell.exec'),uacConsentFromBrowser:true},
    {...request('core.shell.exec'),vmId:VM},
    {...request('core.process.start'),stopTarget:{pid:1}},
    {...request('core.process.stop'),stopTarget:{pid:4242}},
    {...request('core.process.stop'),shell:{executable:'cmd.exe',arguments:[]}},
    {...request('hyperv.vm.start'),vmId:'ReVoltVPN-Ubuntu-Lab'},
    {...request('hyperv.vm.stop'),shell:{executable:'cmd.exe',arguments:[]}},
    {...request('hyperv.vm.status'),vmId:'*'},
    {...request('core.shell.exec'),action:'shell.exec'},
    {...request('core.shell.exec'),mode:'FULL'},
  ];
  for(const candidate of malformed){
    assert.equal(evaluate(candidate).reason,'INVALID_TYPED_REQUEST',
      JSON.stringify(candidate));
  }
  const noVm=context();noVm.approvedVmIds=[];
  assert.equal(evaluate(request('hyperv.vm.start'),noVm).reason,'VM_GUID_NOT_APPROVED');
  const noProcess=context();noProcess.stopProcessIdentityVerified=false;
  assert.equal(evaluate(request('core.process.stop'),noProcess).reason,
    'PROCESS_IDENTITY_UNVERIFIED');
});

test('#17 missing local physical UAC enrollment never means a per-command remote consent fallback',()=>{
  for(const property of [
    'localPhysicalUacConsentVerified',
    'signedEnrollmentStoredInProtectedBroker',
    'trustedInstallerRollbackBindingVerified',
  ] as const){
    const c=context();c.localBootstrap[property]=false;
    const result=evaluate(request(),c);
    assert.equal(result.reason,'LOCAL_ONE_TIME_UAC_BOOTSTRAP_UNVERIFIED');
    assert.equal(result.status,'pending');
    assert.equal(result.oneTimeBootstrapAlreadyVerified,false);
    neverExecuted(result);
  }
});
