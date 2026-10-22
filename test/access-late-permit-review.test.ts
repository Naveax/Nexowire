import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {reviewLateDispatchPermit,brokerDispatchPermitSigningBytes,
  dispatchFenceSigningBytes,type SignedCurrentDispatchFence,
  type SignedBrokerDispatchPermit} from '../src/product/access-late-permit-review.js';
import {casReadbackSigningBytes,type QueuedAccessRequest,
 type QueuedAccessDependencies,type CasReadbackRecord}
 from '../src/product/access-queued-job-review.js';
import {installedBrokerSigningBytes,
 type InstalledBrokerNonceRecord} from '../src/product/access-native-broker-proof.js';
import type {AccessEffectiveAuthority,EffectiveAccessStatus}
 from '../src/product/access-effective-authority.js';
import type {ProductDeviceRecord} from '../src/product/control-plane-store.js';

const casKeys=generateKeyPairSync('ed25519');
const nativeKeys=generateKeyPairSync('ed25519');
const permitKeys=generateKeyPairSync('ed25519');
const attackerKeys=generateKeyPairSync('ed25519');
const now=Date.parse('2026-10-22T06:00:00.000Z');
const ids={authority:randomUUID(),broker:randomUUID(),dispatch:randomUUID(),
 request:randomUUID(),owner:randomUUID(),device:randomUUID(),
 deviceEpoch:randomUUID(),sessionEpoch:randomUUID()};
const image={pid:7777,creationFiletime:'134092012301239777',
 volumeSerialHex:'abcd1234',imageFileIdHex:'a1'.repeat(16),
 imageSha256:'d'.repeat(64),brokerVersion:'1.0.5'};
const credentialHash='a'.repeat(64),sessionHash='b'.repeat(64);
const device={id:ids.device,ownerAccountId:ids.owner,
 credentialHash,platform:'win32',accessMode:'full',online:true,
 privilegeMode:'broker',adminBridgeReady:true} as ProductDeviceRecord;
const session={ownerAccountId:ids.owner,sessionHash,
 sessionExpiresAt:'2026-10-22T07:00:00.000Z',loginIsRevoked:false};
const context=()=>({device,session,corePreferenceEnabled:true,
 bridgeDesiredMode:'auto' as const});
const job=(changes:Partial<QueuedAccessRequest>={}):QueuedAccessRequest=>({
 mode:'CORE',requestId:ids.request,ownerId:ids.owner,
 deviceId:ids.device,deviceEpoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
 ownerEpoch:8,grantGeneration:11,credentialHash,sessionHash,
 rootIssuedAt:null,rootExpiresAt:null,effectState:'queued',
 cachedUiEffective:true,...changes,
});
const positive:EffectiveAccessStatus={
 requestedMode:'CORE',state:'EFFECTIVE',effective:true,
 verifiedNativeHighToken:true,authoritySource:'independent-protected-windows-broker',
 localEnrollmentVerified:true,actualElevatedTokenVerified:true,
 brokerSourceAclVerified:true,brokerVersionVerified:true,
 requiresPerCommandUac:false,canDispatch:false,reason:'SOURCE_FIXTURE_ONLY',
};
const signAs=(value:Buffer,key:typeof nativeKeys.privateKey)=>
 sign(null,value,key).toString('base64url');
const permit=(j:QueuedAccessRequest,changes:Partial<SignedBrokerDispatchPermit>={})
 :SignedBrokerDispatchPermit=>({
 kind:'broker_dispatch_permit_v1',
 authorityId:ids.authority,brokerId:ids.broker,dispatchId:ids.dispatch,
 challengeNonce:'f'.repeat(64),requestId:j.requestId,
 fingerprint:'e'.repeat(64),capability:'admin.shell',
 ownerId:j.ownerId,deviceId:j.deviceId,
 deviceEpoch:j.deviceEpoch,sessionEpoch:j.sessionEpoch,
 ownerEpoch:j.ownerEpoch,generation:j.grantGeneration,
 privilege:j.mode,issuedAtMs:now-150,expiresAtMs:now+2500,
 ...changes,
});
const nativeReport=(j:QueuedAccessRequest,nonce:string):InstalledBrokerNonceRecord=>({
 kind:'nexowire.access.installed-broker-nonce.v1',
 source:'protected-installed-broker-process',
 requestId:j.requestId,challengeNonce:nonce,ownerId:j.ownerId,
 deviceId:j.deviceId,deviceEpoch:j.deviceEpoch,sessionEpoch:j.sessionEpoch,
 ownerEpoch:j.ownerEpoch,grantGeneration:j.grantGeneration,
 privilege:j.mode,brokerPid:image.pid,creationFiletime:image.creationFiletime,
 volumeSerialHex:image.volumeSerialHex,imageFileIdHex:image.imageFileIdHex,
 imageSha256:image.imageSha256,brokerVersion:image.brokerVersion,
 nativeTokenIntegrity:'high',enabledAdministrators:true,
 publisherAndReleasePinned:true,protectedParentImportUpdaterTree:true,
 processDupHandleBoundaryVerified:true,observedAtMs:now-100,expiresAtMs:now+2500,
});
const casRecord=(j:QueuedAccessRequest,nonce:string,revoking:boolean):CasReadbackRecord=>({
 kind:'nexowire.access.cas-readback.v1',authorityId:ids.authority,
 requestId:j.requestId,challengeNonce:nonce,deviceId:j.deviceId,
 ownerId:j.ownerId,deviceEpoch:j.deviceEpoch,sessionEpoch:j.sessionEpoch,
 ownerEpoch:j.ownerEpoch,grantGeneration:j.grantGeneration,privilege:j.mode,
 revoked:false,revoking,observedAtMs:now-100,expiresAtMs:now+2500,
});
type World={
 revoking:boolean;revoked:boolean;ownerEpoch:number;grantGeneration:number;
 deviceEpoch:string;sessionEpoch:string;ownerId:string;
 pendingDispatchId:string|null;clock:number;
 };
function fixture(opts:{freshEffective?:boolean;signPermitWith?:typeof permitKeys.privateKey;
 permitPatch?:Partial<SignedBrokerDispatchPermit>;
 jobPatch?:Partial<QueuedAccessRequest>;
 fenceSigner?:typeof casKeys.privateKey;
 fenceMutator?:(v:SignedCurrentDispatchFence)=>SignedCurrentDispatchFence;
 mutation?:(stage:'before'|'after'|'native'|'cas')=>Promise<void>|void;
}={}){
 const state:World={
  revoking:false,revoked:false,ownerEpoch:8,grantGeneration:11,
  deviceEpoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
  ownerId:ids.owner,pendingDispatchId:ids.dispatch,clock:now,
 };
 const reads:{fence:number;native:number;cas:number;high:number;project:number}={
  fence:0,native:0,cas:0,high:0,project:0};
 const j=job(opts.jobPatch);
 const requestPermit=permit(j,opts.permitPatch);
 const incoming={payload:requestPermit,signature:signAs(
   brokerDispatchPermitSigningBytes(requestPermit),
   opts.signPermitWith??permitKeys.privateKey)};
 const deps={
  authorityId:ids.authority,dispatchAuthorityId:ids.authority,
  independentCasPublicKey:casKeys.publicKey,
  dispatchPermitPublicKey:permitKeys.publicKey,
  expectedBrokerId:ids.broker,expectedFingerprint:'e'.repeat(64),
  expectedCapability:'admin.shell',
  expectedPendingChallengeNonce:'f'.repeat(64),
  installedBroker:{publicKey:nativeKeys.publicKey,process:image},
  effectiveAuthority:{project:async()=>{
   reads.project++;
   return opts.freshEffective===false?{
     ...positive,state:'PAUSED_UNVERIFIED' as const,effective:false,
   }:positive;
  }} as unknown as AccessEffectiveAuthority,
  fetchCurrentDispatchFence:async()=>{
   reads.fence++;
   const at=reads.fence===1?'before':'after';
   await opts.mutation?.(at);
   const statement:SignedCurrentDispatchFence={
    kind:'nexowire.access.dispatch-fence-readback.v1',
    authorityId:ids.authority,requestId:j.requestId,
    dispatchId:ids.dispatch,challengeNonce:'f'.repeat(64),
    ownerId:state.ownerId,deviceId:j.deviceId,
    deviceEpoch:state.deviceEpoch,sessionEpoch:state.sessionEpoch,
    ownerEpoch:state.ownerEpoch,grantGeneration:state.grantGeneration,
    revoking:state.revoking,revoked:state.revoked,
    pendingDispatchId:state.pendingDispatchId,
    observedAtMs:state.clock,expiresAtMs:state.clock+2000,
   };
   const reported=opts.fenceMutator?.(statement)??statement;
   return {statement:reported,signature:signAs(dispatchFenceSigningBytes(reported),
     opts.fenceSigner??casKeys.privateKey)};
  },
  readInstalledBroker:async (j:QueuedAccessRequest,nonce:string)=>{
   reads.native++;
   await opts.mutation?.('native');
   const r=nativeReport(j,nonce);
   return {statement:r,signature:signAs(installedBrokerSigningBytes(r),nativeKeys.privateKey)};
  },
  readCas:async (j:QueuedAccessRequest,nonce:string)=>{
   reads.cas++;
   await opts.mutation?.('cas');
   const r=casRecord(j,nonce,state.revoking);
   return {statement:r,signature:signAs(casReadbackSigningBytes(r),casKeys.privateKey)};
  },
  readHighWater:async()=>{
   reads.high++;
   return {ownerId:state.ownerId,deviceEpoch:state.deviceEpoch,
    sessionEpoch:state.sessionEpoch,ownerEpoch:state.ownerEpoch,
    grantGeneration:state.grantGeneration,revoking:state.revoking,revoked:state.revoked};
  },
  now:()=>state.clock,
 };
 return {state,reads,j,incoming,deps};
}
const review=async(f:ReturnType<typeof fixture>,
 changes:Partial<QueuedAccessRequest>={})=>
 reviewLateDispatchPermit({...f.j,...changes},context(),f.incoming,
   f.deps);

test('source-green CORE requires fresh signed nonce/epoch native HIGH candidate AND CAS but never authorizes execution',async()=>{
 const f=fixture();
 const r=await review(f);
 assert.equal(r.status,'CURRENT_SOURCE_ONLY_NO_EXECUTION');
 assert.equal(r.coreEffectiveAtReview,true);
 assert.equal(r.elevatedExecutionAllowed,false);
 assert.equal(r.noPerCommandUacAfterLegitimateEnrollment,true);
 assert.equal(r.mayReplay,false);
 assert.deepEqual(f.reads,{fence:2,native:1,cas:1,high:1,project:1});
});

test('#731 real valid Ed25519 pre-revoke permit DELIVERED after other Hub begins revokeAndDrain: deny',async()=>{
 // Hub A has a signed permit reserved before this request; Hub B signals
 // external revoke, but final drained state and generation remain unchanged.
 const f=fixture();
 f.state.revoking=true;
 const r=await review(f);
 assert.equal(r.status,'DENIED');
 assert.equal(r.reason,'REVOKE_OR_REPAIR_DURING_PERMIT_DELIVERY');
 assert.equal(f.reads.native,0);
 assert.equal(r.elevatedExecutionAllowed,false);
});

test('Hub B revoke begins while Hub A awaits native+CAS readback: second dispatch fence must deny',async()=>{
 const f=fixture({mutation:stage=>{if(stage==='after')f.state.revoking=true}});
 const r=await review(f);
 assert.equal(r.status,'DENIED');
 assert.equal(r.reason,'REVOKE_OR_REPAIR_AFTER_ACCESS_READBACK');
 assert.equal(f.reads.project,1);
 assert.equal(r.mayReplay,false);
});

test('revoked CORE, owner re-pair and session epoch reconnect reject late signed permit despite green dashboard',async()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{f.state.revoked=true},
  (f:ReturnType<typeof fixture>)=>{f.state.ownerEpoch=9},
  (f:ReturnType<typeof fixture>)=>{f.state.grantGeneration=12},
  (f:ReturnType<typeof fixture>)=>{f.state.ownerId=randomUUID()},
  (f:ReturnType<typeof fixture>)=>{f.state.deviceEpoch=randomUUID()},
  (f:ReturnType<typeof fixture>)=>{f.state.sessionEpoch=randomUUID()},
  (f:ReturnType<typeof fixture>)=>{f.state.pendingDispatchId=randomUUID()},
 ]){
  const f=fixture();mutate(f);
  assert.equal((await review(f)).status,'DENIED');
 }
});

test('foreign signer, forged nonce, reused requestId, wrong capability and scope deny',async()=>{
 for(const patch of [
  {challengeNonce:'a'.repeat(64)}, {requestId:randomUUID()},
  {ownerEpoch:9}, {generation:12}, {deviceEpoch:randomUUID()},
  {sessionEpoch:randomUUID()}, {capability:'admin.hyperv'},
  {brokerId:randomUUID()}, {fingerprint:'b'.repeat(64)},
 ]){
  const f=fixture({permitPatch:patch});
  assert.equal((await review(f)).status,'DENIED');
 }
 const forged=fixture({signPermitWith:attackerKeys.privateKey});
 assert.equal((await review(forged)).reason,'PERMIT_UNTRUSTED');
});

test('cached EFFECTIVE UI and valid late permit never override fresh revoked Access/installed Broker',async()=>{
 const f=fixture({freshEffective:false});
 const r=await review(f);
 assert.equal(r.status,'DENIED');
 assert.equal(r.reason,'ACCESS_FRESH_PROOF_DENIED');
 assert.equal(r.elevatedExecutionAllowed,false);
});

test('ROOT exact 15-minute boundary checked again after late permit and CAS await',async()=>{
 const rootIssued=now-900_000,rootExpiry=now;
 // Handshake starts at one millisecond before expiry. The CAS completes
 // after expiry, which must deny even though source had earlier EFFECTIVE.
 const f=fixture({mutation:stage=>{if(stage==='after')f.state.clock=now}});
 f.state.clock=now-1;
 // Use an actually signed ROOT-specific permit, not a CORE mismatch.
 const root=fixture({
   jobPatch:{mode:'ROOT',rootIssuedAt:new Date(rootIssued).toISOString(),
     rootExpiresAt:new Date(rootExpiry).toISOString()},
   mutation:stage=>{if(stage==='after')root.state.clock=now},
 });
 root.state.clock=now-1;
 const r=await review(root);
 assert.equal(r.status,'DENIED');
 assert.equal(r.reason,'ROOT_OR_PERMIT_EXPIRED_AT_DISPATCH');
 assert.equal(root.reads.project,1);
 assert.equal(r.elevatedExecutionAllowed,false);
});

test('unknown possibly dispatched operation never retries despite historical signed permit',async()=>{
 const f=fixture();
 const r=await review(f,{effectState:'may-have-dispatched'});
 assert.equal(r.status,'UNKNOWN_RECONCILE');
 assert.equal(r.mayReplay,false);
 assert.deepEqual(f.reads,{fence:0,native:0,cas:0,high:0,project:0});
});

test('missing external CAS or native high provider never returns EFFECTIVE/dispatch',async()=>{
 const f=fixture({mutation:stage=>{
  if(stage==='native')throw Error('NATIVE_AUTHZ_MISSING');
 }});
 const r=await review(f);
 assert.equal(r.status,'DENIED');
 assert.equal(r.reason,'ACCESS_FRESH_PROOF_DENIED');
 assert.equal(r.elevatedExecutionAllowed,false);
});


test('forged or stale SIGNED post-permit CAS fence never turns callback boolean into dispatch right',async()=>{
 const bad=[
  {fenceSigner:attackerKeys.privateKey},
  {fenceMutator:(v:SignedCurrentDispatchFence)=>({...v,challengeNonce:'a'.repeat(64)})},
  {fenceMutator:(v:SignedCurrentDispatchFence)=>({...v,requestId:randomUUID()})},
  {fenceMutator:(v:SignedCurrentDispatchFence)=>({...v,dispatchId:randomUUID()})},
  {fenceMutator:(v:SignedCurrentDispatchFence)=>({...v,authorityId:randomUUID()})},
  {fenceMutator:(v:SignedCurrentDispatchFence)=>({...v,ownerEpoch:100})},
  {fenceMutator:(v:SignedCurrentDispatchFence)=>({...v,observedAtMs:now-9000})},
  {fenceMutator:(v:SignedCurrentDispatchFence)=>({...v,pendingDispatchId:null})},
 ];
 for(const opts of bad){
  const f=fixture(opts);
  const result=await review(f);
  assert.equal(result.status,'DENIED');
  assert.equal(result.reason,'REVOKE_OR_REPAIR_DURING_PERMIT_DELIVERY');
  assert.equal(result.elevatedExecutionAllowed,false);
 }
});

test('signed ROOT permit works just before 15-minute boundary as a source review, not executor',async()=>{
 const expiry=now+1;
 const f=fixture({jobPatch:{
  mode:'ROOT',rootIssuedAt:new Date(expiry-900_000).toISOString(),
  rootExpiresAt:new Date(expiry).toISOString(),
 }});
 const r=await review(f);
 assert.equal(r.status,'CURRENT_SOURCE_ONLY_NO_EXECUTION');
 assert.equal(r.coreEffectiveAtReview,false);
 assert.equal(r.elevatedExecutionAllowed,false);
 assert.equal(r.noPerCommandUacAfterLegitimateEnrollment,true);
});


test('#731 inter-Hub adversarial barrier: revokeAndDrain enters while late signed permit readback is suspended',async()=>{
 let readEntered!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{readEntered=resolve});
 const blocked=new Promise<void>(resolve=>{release=resolve});
 const f=fixture({mutation:async stage=>{
   if(stage==='before'){
     readEntered(); await blocked;
   }
 }});
 const pending=review(f);
 await entered;
 // Separate Hub B begins revocation AFTER Hub A verified the earlier
 // validly signed permit, BEFORE it receives authenticated CAS state.
 f.state.revoking=true;
 release();
 const result=await pending;
 assert.equal(result.status,'DENIED');
 assert.equal(result.reason,'REVOKE_OR_REPAIR_DURING_PERMIT_DELIVERY');
 assert.equal(f.reads.native,0);
 assert.equal(result.elevatedExecutionAllowed,false);
 assert.equal(result.mayReplay,false);
});
