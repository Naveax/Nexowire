import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  HYPERV_ELEVATED_DISPATCH_ENABLED,
  HypervVmRequestSchema,HypervVmGrantSchema,
  evaluateHypervVmRequest,type HypervVmGateContext,
} from '../src/security/hyperv-vm-admission.js';
import {isPrivilegedBrokerCapability,privilegeRequirement} from '../src/security/privilege.js';

const guid='c9fd67cb-49e0-4a55-9c2b-b604dc05ec44';
const digest='a'.repeat(64);
const now=new Date('2026-10-21T12:00:00Z');
const intent=(capability='hyperv.vm.start')=>({
  type:'hyperv.vm.request',version:1,capability,requestId:randomUUID(),
  vmId:guid,deviceId:'device-1',ownerAccountId:'owner-1',
  credentialBinding:digest,issuedAt:'2026-10-21T11:59:40Z',
  expiresAt:'2026-10-21T12:01:00Z',
});
function context():HypervVmGateContext {
 return {deviceId:'device-1',ownerAccountId:'owner-1',credentialBinding:digest,
  now,hasConsumedRequestId:()=>false,
  grants:[{vmId:guid,deviceId:'device-1',ownerAccountId:'owner-1',
    credentialBinding:digest,allowStatus:true,allowStart:true,allowStop:false,
    expiresAt:'2026-10-21T12:01:30Z'}],
  signedOwnerIntentVerified:true,privilegedBrokerAuthenticated:true,
  brokerVersionMatch:true,localPhysicalApproval:'confirmed',
  trust:{provenance:'independent-windows-native',helperAuthenticodeValid:true,
    publisherPinned:true,signedReleaseManifestVerified:true,
    helperExeImageIdentityMatched:true,launcherFileAclProtected:true,
    launcherAncestorAclProtected:true,helperImportTreeAclProtected:true,
    updaterPathsAclProtected:true,processTokenAuthorityVerified:true},
 };
}
const deny=(raw:unknown,c=context())=>evaluateHypervVmRequest(raw,c).execution.reason;

test('shell.exec does not elevate, typed Hyper-V never enters existing broker dispatch',()=>{
 assert.equal(HYPERV_ELEVATED_DISPATCH_ENABLED,false);
 assert.equal(privilegeRequirement('shell.exec',{command:'Start-VM'}),'standard');
 assert.equal(isPrivilegedBrokerCapability('shell.exec'),false);
 for(const capability of ['hyperv.vm.status','hyperv.vm.start','hyperv.vm.stop']){
   assert.equal(privilegeRequirement(capability,{}),'elevated');
   assert.equal(isPrivilegedBrokerCapability(capability),false,
    'new typed capability must NOT be accepted by the existing elevated Broker');
 }
});

test('even fully fabricated green context remains denied, with no handler or shell',()=>{
 for(const op of ['hyperv.vm.status','hyperv.vm.start']){
   const result=evaluateHypervVmRequest(intent(op),context());
   assert.equal(result.execution.reason,'HYPERV_DISPATCH_DISABLED_SOURCE_ONLY');
   assert.equal(result.execution.status,'denied');
   assert.equal(result.execution.effectVerified,false);
   assert.equal(result.execution.retrySafe,false);
   assert.equal('command' in result,false);
   assert.equal('shell' in result,false);
 }
});

test('exact canonical GUID and strict argument schema reject VM names, wildcard, scripts, supplied consent and arbitrary executable',()=>{
 for(const patch of [
   {vmId:'ReVoltVPN-Ubuntu-Lab'}, {vmId:'*'},
   {vmId:guid.toUpperCase()}, {vmId:guid+';Stop-VM'},
   {vmId:'00000000-0000-0000-0000-00000000000Z'},
   {vmName:'ReVoltVPN-Ubuntu-Lab'}, {command:'Start-VM'},
   {executable:'powershell.exe'}, {args:['-Command','Start-VM']},
   {shell:'shell.exec'}, {approved:true}, {consent:true}, {script:'a'},
   {host:'unapproved'}, {vmIds:[guid]}, {capability:'shell.exec'},
 ]){
   assert.equal(deny({...intent(),...patch}),'HYPERV_REQUEST_SCHEMA_DENIED',
     'unexpected caller input '+JSON.stringify(patch));
 }
 assert.equal(HypervVmRequestSchema.safeParse(intent()).success,true);
 assert.equal(HypervVmGrantSchema.safeParse(context().grants[0]).success,true);
});

test('per-owner/host/pairing immutable VM GUID allowlist denies mismatch and lookalike GUID',()=>{
 for(const patch of [{deviceId:'other'}, {ownerAccountId:'other'},
   {credentialBinding:'b'.repeat(64)}]){
   assert.equal(deny({...intent(),...patch}),'HYPERV_BOUND_IDENTITY_MISMATCH');
 }
 for(const patch of [{vmId:'00000000-0000-0000-0000-000000000001'}]){
   assert.equal(deny({...intent(),...patch}),'HYPERV_VM_GUID_NOT_ALLOWLISTED');
 }
 for(const grantPatch of [{vmId:'00000000-0000-0000-0000-000000000002'},
  {deviceId:'other'}, {ownerAccountId:'other'}, {credentialBinding:'b'.repeat(64)},
  {expiresAt:'2026-10-21T11:00:00Z'}]){
   const c=context();c.grants=[{...c.grants[0]!,...grantPatch}];
   assert.equal(deny(intent(),c),'HYPERV_VM_GUID_NOT_ALLOWLISTED');
 }
});

test('status/start/stop have separate per-VM permissions',()=>{
 const c=context();
 assert.equal(deny(intent('hyperv.vm.stop'),c),'HYPERV_CAPABILITY_NOT_GRANTED');
 c.grants=[{...c.grants[0]!,allowStart:false}];
 assert.equal(deny(intent('hyperv.vm.start'),c),'HYPERV_CAPABILITY_NOT_GRANTED');
 c.grants=[{...c.grants[0]!,allowStatus:false}];
 assert.equal(deny(intent('hyperv.vm.status'),c),'HYPERV_CAPABILITY_NOT_GRANTED');
});

test('request lifetime and durable replay authority are fail-closed',()=>{
 for(const patch of [
  {issuedAt:'2026-10-21T12:00:06Z'}, {expiresAt:'2026-10-21T11:59:00Z'},
  {expiresAt:'2026-10-21T12:02:01Z'},
 ]){
   assert.equal(deny({...intent(),...patch}),'HYPERV_INTENT_EXPIRED_OR_INVALID');
 }
 const c=context();c.hasConsumedRequestId=()=>true;
 assert.equal(deny(intent(),c),'HYPERV_REPLAY_UNKNOWN');
 const offline=context();offline.hasConsumedRequestId=()=>{throw new Error('authority unavailable')};
 assert.equal(deny(intent(),offline),'HYPERV_REPLAY_UNKNOWN');
});

test('owner signed intent, authenticated/version-matched privileged bridge required',()=>{
 const c=context();c.signedOwnerIntentVerified=false;
 assert.equal(deny(intent(),c),'HYPERV_OWNER_INTENT_UNVERIFIED');
 for(const change of [{privilegedBrokerAuthenticated:false},{brokerVersionMatch:false}]){
  const x=context();Object.assign(x,change);
  assert.equal(deny(intent(),x),'HYPERV_BROKER_UNVERIFIED');
 }
});

test('all individual Authenticode, manifest, exe identity, and launcher/import/parent/updater ACL gates fail closed',()=>{
 const keys=[
  'helperAuthenticodeValid','publisherPinned','signedReleaseManifestVerified',
  'helperExeImageIdentityMatched','launcherFileAclProtected',
  'launcherAncestorAclProtected','helperImportTreeAclProtected',
  'updaterPathsAclProtected','processTokenAuthorityVerified',
 ] as const;
 for(const key of keys){
  const c=context();c.trust[key]=false;
  assert.equal(deny(intent(),c),'HYPERV_HELPER_TRUST_UNVERIFIED',key);
 }
 const c=context();c.trust.provenance='unverified';
 assert.equal(deny(intent(),c),'HYPERV_HELPER_TRUST_UNVERIFIED');
});

test('secure desktop pending, declined, unknown or remote-approved fields never permit mutation',()=>{
 for(const localPhysicalApproval of ['pending','unknown'] as const){
   const c=context();c.localPhysicalApproval=localPhysicalApproval;
   const result=evaluateHypervVmRequest(intent(),c);
   assert.equal(result.execution.status,'pending');
   assert.equal(result.execution.reason,'HYPERV_LOCAL_APPROVAL_REQUIRED');
   assert.equal(result.execution.effectVerified,false);
 }
 const c=context();c.localPhysicalApproval='denied';
 assert.equal(deny(intent(),c),'HYPERV_LOCAL_APPROVAL_DECLINED');
 assert.equal(deny({...intent(),approved:true},context()),'HYPERV_REQUEST_SCHEMA_DENIED');
});

test('status reply cannot invent fresh independent VM state or UAC consent',()=>{
 const out=evaluateHypervVmRequest(intent('hyperv.vm.status'),context());
 assert.equal(out.execution.status,'denied');
 assert.equal(out.execution.effectVerified,false);
 assert.equal('vmState' in out,false);
 assert.equal('vmName' in out.target,false);
 assert.equal(out.audit.source,'source-only-policy-evaluation');
 assert.equal(out.audit.requestId!==null,true);
});
