import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  CoreBrokerExecutionRequestSchema,
  evaluateCoreBrokerExecution,type CoreBrokerContext,
} from '../src/security/core-broker-executor-contract.js';
import {isPrivilegedBrokerCapability,privilegeRequirement} from '../src/security/privilege.js';

const time=new Date('2026-10-21T13:00:00.000Z');
const sha='a'.repeat(64),otherSha='b'.repeat(64);
const vmId='2eb71c03-a5f2-4f16-bbbf-c0d29ee2a791';
const request=(mode:'CORE'|'ROOT'='CORE',action='core.shell.exec')=>({
  type:'core-broker.execute',version:1,requestId:randomUUID(),
  deviceId:'device-1',ownerAccountId:'owner-1',ownerEpoch:17,
  credentialBinding:sha,mode,action,
  issuedAt:'2026-10-21T12:59:40.000Z',expiresAt:'2026-10-21T13:00:20.000Z',
  ...(action==='core.shell.exec'||action==='core.process.start'
    ? {shell:{executable:'C:\\Windows\\System32\\cmd.exe',arguments:['/C','echo test'],
         workingDirectory:'C:\\Temp'}} : {}),
  ...(action==='core.process.stop'
    ? {stopTarget:{pid:99999,processCreationFiletime:'133000000000000000',
       expectedImageSha256:otherSha}}:{}),
  ...(action.startsWith('hyperv.vm.')?{vmId}:{}),
});
function context(mode:'CORE'|'ROOT'='CORE'):CoreBrokerContext{
  return {
    now:time,deviceId:'device-1',ownerAccountId:'owner-1',
    credentialBinding:sha,authoritativeOwnerEpoch:17,ownerRevoked:false,
    enrollment:{deviceId:'device-1',ownerAccountId:'owner-1',
      credentialBinding:sha,ownerEpoch:17,enrollmentId:randomUUID(),mode,
      activatedAt:'2026-10-21T12:55:00.000Z',
      expiresAt:mode==='ROOT'?'2026-10-21T13:10:00.000Z':null,
      ownerSignedGrantDigest:otherSha,brokerInstalledImageSha256:sha},
    localBootstrap:{
      localPhysicalUacConsentVerified:true,
      signedEnrollmentStoredInProtectedBroker:true,
      trustedInstallerRollbackBindingVerified:true},
    trustedRuntime:{
      evidenceProvenance:'independent-windows-native',
      brokerProcessHighIntegrity:true,administratorsTokenEnabled:true,
      brokerAuthenticatedAndVersionMatched:true,
      runningImageIdentityMatched:true,expectedBrokerImageSha256:sha,
      imageAuthenticodePublisherPinned:true,
      signedReleaseAndRollbackManifestVerified:true,
      brokerExeAndParentAclProtected:true,importedModulesAclProtected:true,
      updaterPathsAclProtected:true,processHandleDuplicationBoundaryProtected:true},
    ownerIntentSignatureVerified:true,enrollmentSignatureVerified:true,
    ownerEpochWitnessVerified:true,requestAlreadyReserved:()=>false,
    pendingMutationUnknown:false,approvedVmIds:[vmId],
    stopProcessIdentityVerified:true,
  };
}
const check=(raw:unknown,ctx=context())=>evaluateCoreBrokerExecution(raw,ctx);

test('CORE broad elevated shell/process contract is separate from existing standard shell.exec',()=>{
 assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
 assert.equal(privilegeRequirement('shell.exec',{command:'whoami'}),'standard');
 assert.equal(isPrivilegedBrokerCapability('shell.exec'),false);
 assert.equal(privilegeRequirement('core.shell.exec',{}),'elevated');
 assert.equal(privilegeRequirement('core.process.start',{}),'elevated');
 assert.equal(privilegeRequirement('core.process.stop',{}),'elevated');
 assert.equal(isPrivilegedBrokerCapability('core.shell.exec'),false);
 assert.equal(isPrivilegedBrokerCapability('core.process.start'),false);
 assert.equal(CoreBrokerExecutionRequestSchema.safeParse(request()).success,true);
 assert.equal(check(request()).reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
 for(const action of ['core.shell.exec','core.process.start']){
   assert.equal(check(request('CORE',action)).reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
 }
});
test('CORE enrollment survives multiple commands without repeated UAC while Broker stays verified',()=>{
 const c=context();
 const a=check(request('CORE','core.shell.exec'),c);
 const b=check(request('CORE','core.process.start'),c);
 assert.equal(a.oneTimeBootstrapAlreadyVerified,true);
 assert.equal(a.requiresPerCommandUac,false);
 assert.equal(b.oneTimeBootstrapAlreadyVerified,true);
 assert.equal(b.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
 assert.equal(a.privilegedExecutionOccurred,false);
});
test('ROOT can have broad executor access for at most 15 minutes, never auto-extend',()=>{
 const c=context('ROOT');
 assert.equal(check(request('ROOT'),c).reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
 c.enrollment={...c.enrollment!,expiresAt:'2026-10-21T13:10:01.000Z'};
 assert.equal(check(request('ROOT'),c).reason,'ROOT_15_MINUTES_EXCEEDED');
 c.enrollment={...c.enrollment!,expiresAt:null};
 assert.equal(check(request('ROOT'),c).reason,'ROOT_15_MINUTES_EXCEEDED');
 c.enrollment={...c.enrollment!,expiresAt:'2026-10-21T13:10:00.000Z'};
 c.now=new Date('2026-10-21T13:10:00.000Z');
 const freshRequest={...request('ROOT'),issuedAt:'2026-10-21T13:09:40.000Z',
   expiresAt:'2026-10-21T13:10:20.000Z'};
 assert.equal(check(freshRequest,c).reason,'ROOT_15_MINUTES_EXCEEDED');
});
test('owner epoch and device binding revoke all previously elevated requests',()=>{
 for(const patch of [{deviceId:'other'},{ownerAccountId:'attacker'},
   {credentialBinding:otherSha},{ownerEpoch:18}]){
   assert.equal(check({...request(),...patch}).reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
 }
 const c=context();c.ownerRevoked=true;
 assert.equal(check(request(),c).reason,'GRANT_REVOKED');
 const x=context();x.authoritativeOwnerEpoch=18;
 assert.equal(check(request(),x).reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
 const y=context();y.enrollment={...y.enrollment!,brokerInstalledImageSha256:otherSha};
 assert.equal(check(request(),y).reason,'MISSING_SIGNED_ENROLLMENT');
});
test('forged UAC approval, extra shell fields, mode inflation and malformed process stop are refused',()=>{
 for(const patch of [
   {approved:true},{uacApproved:true},{consent:true},{runAs:true},
   {elevation:'silent'},{mode:'FULL'}, {capability:'shell.exec'},
   {action:'hyperv.vm.start',vmId:'*'},{action:'shell.exec'},
   {stopTarget:{pid:1}},{script:'Start-VM'},
 ]){
   assert.equal(check({...request(),...patch}).reason,'INVALID_TYPED_REQUEST',JSON.stringify(patch));
 }
 assert.equal(check({...request(),shell:undefined,stopTarget:{pid:44}}).reason,
   'INVALID_TYPED_REQUEST');
});
test('one-time local installation approval missing requires real local approval, not a new per-command UAC click',()=>{
 for(const k of ['localPhysicalUacConsentVerified',
   'signedEnrollmentStoredInProtectedBroker',
   'trustedInstallerRollbackBindingVerified'] as const){
   const c=context();c.localBootstrap[k]=false;
   const out=check(request(),c);
   assert.equal(out.reason,'LOCAL_ONE_TIME_UAC_BOOTSTRAP_UNVERIFIED',k);
   assert.equal(out.status,'pending');
   assert.equal(out.requiresPerCommandUac,false);
 }
});
test('signed enrollment, owner epoch witness and fresh owner intent all must validate',()=>{
 for(const k of ['ownerIntentSignatureVerified','enrollmentSignatureVerified',
   'ownerEpochWitnessVerified'] as const){
   const c=context();c[k]=false;
   assert.equal(check(request(),c).reason,'OWNER_COMMAND_SIGNATURE_REQUIRED',k);
 }
});
test('high Windows token, signed Broker, pinned image, protected imports and handle boundary must EACH be attested',()=>{
 const keys=['brokerProcessHighIntegrity','administratorsTokenEnabled',
 'brokerAuthenticatedAndVersionMatched','runningImageIdentityMatched',
 'imageAuthenticodePublisherPinned','signedReleaseAndRollbackManifestVerified',
 'brokerExeAndParentAclProtected','importedModulesAclProtected',
 'updaterPathsAclProtected','processHandleDuplicationBoundaryProtected'] as const;
 for(const key of keys){
  const c=context();c.trustedRuntime[key]=false;
  assert.equal(check(request(),c).reason,'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED',key);
 }
 const c=context();c.trustedRuntime.evidenceProvenance='unverified';
 assert.equal(check(request(),c).reason,'ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED');
});
test('lost mutation ACK/replay ledger unavailable never auto-replays an elevated command',()=>{
 const c=context();c.pendingMutationUnknown=true;
 const o=check(request(),c);
 assert.equal(o.reason,'UNKNOWN_MUTATION_NO_REPLAY');
 assert.equal(o.status,'unknown');assert.equal(o.automaticallyRetryable,false);
 const c2=context();c2.requestAlreadyReserved=()=>true;
 assert.equal(check(request(),c2).reason,'STALE_OR_REPLAYED_REQUEST');
 const c3=context();c3.requestAlreadyReserved=()=>{throw new Error('durable CAS disconnected')};
 assert.equal(check(request(),c3).reason,'STALE_OR_REPLAYED_REQUEST');
});
test('typed Hyper-V remains exact GUID-only, not a shell-only CORE compromise',()=>{
 assert.equal(check(request('CORE','hyperv.vm.status')).reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
 assert.equal(check(request('CORE','hyperv.vm.start')).reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
 assert.equal(check(request('CORE','hyperv.vm.stop')).reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
 const c=context();c.approvedVmIds=[];
 assert.equal(check(request('CORE','hyperv.vm.start'),c).reason,'VM_GUID_NOT_APPROVED');
 assert.equal(check({...request('CORE','hyperv.vm.start'),vmId:'ReVoltVPN-Ubuntu-Lab'}).reason,
   'INVALID_TYPED_REQUEST');
});
test('PID-only taskkill never counts as process termination proof',()=>{
 const valid=check(request('CORE','core.process.stop'));
 assert.equal(valid.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
 const unverified=context();unverified.stopProcessIdentityVerified=false;
 assert.equal(check(request('CORE','core.process.stop'),unverified).reason,'PROCESS_IDENTITY_UNVERIFIED');
 const invalid={...request('CORE','core.process.stop'),
   stopTarget:{pid:123,processCreationFiletime:'',expectedImageSha256:sha}};
 assert.equal(check(invalid).reason,'INVALID_TYPED_REQUEST');
});
