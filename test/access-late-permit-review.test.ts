import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {reviewFinalDispatchAuthority,finalGrantSigningBytes,
  type FinalNativeEffectGrant,type FinalDispatchDependencies}
  from '../src/product/access-final-dispatch-authority.js';
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

const finalKeys=generateKeyPairSync('ed25519');
function finalFixture(config:{
  finalMutation?:(r:FinalNativeEffectGrant)=>FinalNativeEffectGrant;
  finalSigner?:typeof finalKeys.privateKey;
  missingGrant?:boolean;
  finalClock?:number;
  revokeOnGrant?:boolean;
  nativeSigner?:typeof nativeKeys.privateKey;
  nativeReplacement?:Partial<InstalledBrokerNonceRecord>;
  badPinnedNative?:boolean;
  root?:boolean;
}={}){
 const expiresAt=now;
 const jOpts:Partial<QueuedAccessRequest>=config.root?{
   mode:'ROOT',
   rootIssuedAt:new Date(expiresAt-900_000).toISOString(),
   rootExpiresAt:new Date(expiresAt).toISOString(),
 }: {};
 const f=fixture({jobPatch:jOpts});
 if(config.root)f.state.clock=now-1;
 const counters={native:0,grant:0};
 const dep:FinalDispatchDependencies={
   ...f.deps,
   finalGrantPublicKey:finalKeys.publicKey,
   readNativeAtLaunch:async (job,nonce)=>{
     counters.native++;
     const r={...nativeReport(job,nonce),...config.nativeReplacement};
     return {statement:r,signature:signAs(
       installedBrokerSigningBytes(r),config.nativeSigner??nativeKeys.privateKey)};
   },
   getFinalExternalGrant:async (job,nonce,permitNonce,dispatchId)=>{
     counters.grant++;
     if(config.missingGrant)throw Error('NO_INDEPENDENT_CAS_PRODUCTION');
     if(config.revokeOnGrant){
       f.state.revoking=true;
       throw Error('FINAL_CAS_REVOKE_AND_DRAIN_BEGAN');
     }
     if(config.finalClock!==undefined)f.state.clock=config.finalClock;
     const raw:FinalNativeEffectGrant={
       kind:'nexowire.access.final-native-effect-grant.v1',
       authorityId:ids.authority,requestId:job.requestId,
       dispatchId,brokerId:ids.broker,
       finalNonce:nonce,permitNonce,fingerprint:'e'.repeat(64),
       capability:'admin.shell',ownerId:job.ownerId,deviceId:job.deviceId,
       deviceEpoch:job.deviceEpoch,sessionEpoch:job.sessionEpoch,
       ownerEpoch:job.ownerEpoch,grantGeneration:job.grantGeneration,
       privilege:job.mode,installedBrokerPid:image.pid,
       installedBrokerCreationFiletime:image.creationFiletime,
       installedBrokerVolumeSerialHex:image.volumeSerialHex,
       installedBrokerImageFileIdHex:image.imageFileIdHex,
       installedBrokerVersion:image.brokerVersion,
       installedImageSha256:image.imageSha256,
       ownerRevoked:false,revoking:false,
       reservationState:'FINAL_NATIVE_EFFECT_FENCED',
       issuedAtMs:now-100,expiresAtMs:now+1000,
     };
     const statement=config.finalMutation?.(raw)??raw;
     const signature=signAs(finalGrantSigningBytes(statement),
       config.finalSigner??finalKeys.privateKey);
     return {statement,signature};
   },
 };
 if(config.badPinnedNative)dep.installedBroker={
   publicKey:nativeKeys.publicKey,
   process:{...image,creationFiletime:'134092012301239778'},
 };
 return {f,dep,counters};
}
const finalReview=async(x:ReturnType<typeof finalFixture>)=>
  reviewFinalDispatchAuthority(x.f.j,context(),x.f.incoming,x.dep);

test('independent signed final CAS grant + current installed Broker high-token is required, but not executable proof',async()=>{
 const x=finalFixture();
 const result=await finalReview(x);
 assert.equal(result.status,'FINAL_SOURCE_CANDIDATE_ONLY',result.reason);
 assert.equal(result.dispatchEffective,false);
 assert.equal(result.canLaunch,false);
 assert.equal(result.noRepeatedUacAfterApprovedCore,true);
 assert.equal(result.canReplay,false);
 assert.deepEqual(x.counters,{native:1,grant:1});
});

test('no external FINAL grant, revoked owner while grant is outstanding and forged CAS signer block queued execution',async()=>{
 for(const config of [
   {missingGrant:true},{revokeOnGrant:true},
   {finalSigner:attackerKeys.privateKey},
 ]){
   const x=finalFixture(config);
   const r=await finalReview(x);
   assert.equal(r.status,'DENIED');
   assert.equal(r.canLaunch,false);
 }
});

test('signed final CAS proof must bind fresh launch nonce, request, owner/epoch, generation and installed image PID+FILETIME',async()=>{
 const wrong:Array<(r:FinalNativeEffectGrant)=>FinalNativeEffectGrant>=[
   r=>({...r,finalNonce:'a'.repeat(64)}),
   r=>({...r,permitNonce:'b'.repeat(64)}),
   r=>({...r,requestId:randomUUID()}),
   r=>({...r,dispatchId:randomUUID()}),
   r=>({...r,ownerId:randomUUID()}),
   r=>({...r,deviceEpoch:randomUUID()}),
   r=>({...r,sessionEpoch:randomUUID()}),
   r=>({...r,ownerEpoch:r.ownerEpoch+1}),
   r=>({...r,grantGeneration:r.grantGeneration+1}),
   r=>({...r,privilege:'ROOT'}),
   r=>({...r,installedBrokerPid:r.installedBrokerPid+1}),
   r=>({...r,installedBrokerCreationFiletime:'134092012301239778'}),
   r=>({...r,installedBrokerVolumeSerialHex:'beef1234'}),
   r=>({...r,installedBrokerImageFileIdHex:'ee'.repeat(16)}),
   r=>({...r,installedBrokerVersion:'1.0.4'}),
   r=>({...r,installedImageSha256:'f'.repeat(64)}),
   r=>({...r,issuedAtMs:now-101}),
   r=>({...r,capability:'admin.hyperv'}),
   r=>({...r,authorityId:randomUUID()}),
   r=>({...r,issuedAtMs:now-5000}),
   r=>({...r,expiresAtMs:now}),
 ];
 for(const finalMutation of wrong){
   const x=finalFixture({finalMutation});
   const r=await finalReview(x);
   assert.equal(r.status,'DENIED');
   assert.equal(r.reason,'FINAL_ATOMIC_GRANT_OR_ROOT_LAUNCH_STALE');
   assert.equal(r.canLaunch,false);
 }
});

test('native PID reuse, changed image provider and signed self-process token cannot be substituted at final launch',async()=>{
 const scenarios=[
   {badPinnedNative:true},
   {nativeSigner:attackerKeys.privateKey},
   {nativeReplacement:{creationFiletime:'134092012301239778'}},
   {nativeReplacement:{imageSha256:'f'.repeat(64)}},
   {nativeReplacement:{brokerPid:8008}},
 ];
 for(const item of scenarios){
   const x=finalFixture(item);
   const r=await finalReview(x);
   assert.equal(r.status,'DENIED');
   // A pinned process identity replaced before initial review is rejected
   // there; a replacement discovered at launch is rejected at final gate.
   assert.ok(['INSTALLED_BROKER_HIGH_TOKEN_LAUNCH_PROOF_UNVERIFIED',
     'LATE_PERMIT_OR_EFFECTIVE_ACCESS_NOT_CURRENT'].includes(r.reason),r.reason);
   assert.equal(x.counters.grant,0);
 }
});

test('ROOT final launch before 15 minute expiry is only a source candidate; exactly at expiry denies',async()=>{
 const x=finalFixture({root:true,finalClock:now});
 const r=await finalReview(x);
 assert.equal(r.status,'DENIED');
 assert.equal(r.reason,'FINAL_ATOMIC_GRANT_OR_ROOT_LAUNCH_STALE');
 assert.equal(r.canLaunch,false);
 // ROOT current owner session and signed grant are not a per-command UAC.
 assert.equal(r.noRepeatedUacAfterApprovedCore,true);
});

test('lost ACK after possible native dispatch returns UNKNOWN with no extra CAS or native proof read',async()=>{
 const x=finalFixture();
 const j={...x.f.j,effectState:'may-have-dispatched' as const};
 const r=await reviewFinalDispatchAuthority(j,context(),x.f.incoming,x.dep);
 assert.equal(r.status,'UNKNOWN_RECONCILE');
 assert.equal(r.canReplay,false);
 assert.equal(r.canLaunch,false);
 assert.deepEqual(x.counters,{native:0,grant:0});
});

test('cached UI EFFECTIVE and pre-revoke permit cannot replace fresh final grant',async()=>{
 const x=finalFixture({missingGrant:true});
 x.f.j.cachedUiEffective=true;
 const r=await finalReview(x);
 assert.equal(r.status,'DENIED');
 assert.equal(r.canLaunch,false);
});

test('ROOT genuinely signed fifteen-minute window may pass source review at T-1ms, never actually dispatches',async()=>{
 const x=finalFixture({root:true,finalClock:now-1});
 const result=await finalReview(x);
 assert.equal(result.status,'FINAL_SOURCE_CANDIDATE_ONLY',result.reason);
 assert.equal(result.canLaunch,false);
 assert.equal(result.dispatchEffective,false);
 assert.equal(result.noRepeatedUacAfterApprovedCore,true);
});

test('signed final CAS grant cannot resurrect a permit expired during native proof / final CAS latency',async()=>{
 const x=finalFixture({
  finalClock:now+2510,
  finalMutation:r=>({...r,issuedAtMs:now+2500,expiresAtMs:now+3000}),
 });
 const result=await finalReview(x);
 assert.equal(result.status,'DENIED');
 assert.equal(result.reason,'FINAL_ATOMIC_GRANT_OR_ROOT_LAUNCH_STALE');
 assert.equal(result.canLaunch,false);
});

test('Access strict signed final grant JSON rejects version/type confusion and unrecognized privileged fields',async()=>{
 const mutated:Array<(r:FinalNativeEffectGrant)=>Record<string,unknown>>=[
  r=>({...r,installedBrokerPid:String(r.installedBrokerPid)}),
  r=>({...r,installedBrokerCreationFiletime:Number(r.installedBrokerCreationFiletime)}),
  r=>({...r,installedBrokerVolumeSerialHex:true}),
  r=>({...r,installedBrokerImageFileIdHex:['a1']}),
  r=>({...r,installedBrokerVersion:1}),
  r=>({...r,grantGeneration:'11'}),
  r=>({...r,ownerRevoked:'false'}),
  r=>({...r,revoking:0}),
  r=>({...r,externalCommitApproved:true}),
  r=>({...r,reservationState:'RESERVED_ONLY'}),
 ];
 for(const mutate of mutated){
  const x=finalFixture();
  const trusted=x.dep.getFinalExternalGrant;
  x.dep.getFinalExternalGrant=async (job,nonce,permitNonce,dispatchId)=>{
   const old=await trusted(job,nonce,permitNonce,dispatchId);
   const raw=mutate(old.statement as FinalNativeEffectGrant);
   // Deliberately sign malformed JSON, bypassing only the TEST signer
   // builder; Access strict parser must reject it before any admission.
   return {statement:raw,signature:signAs(
     Buffer.from(JSON.stringify(raw)),finalKeys.privateKey)};
  };
  const r=await finalReview(x);
  assert.equal(r.status,'DENIED');
  assert.equal(r.canLaunch,false);
  assert.equal(r.reason,'FINAL_ATOMIC_GRANT_OR_ROOT_LAUNCH_STALE');
 }
});

test('otherwise valid signed FINAL grant issued one millisecond before installed native witness is only an old reservation',async()=>{
 const x=finalFixture({
  finalMutation:r=>({...r,issuedAtMs:now-101}),
 });
 const r=await finalReview(x);
 assert.equal(r.status,'DENIED');
 assert.equal(r.reason,'FINAL_ATOMIC_GRANT_OR_ROOT_LAUNCH_STALE');
 assert.equal(r.canLaunch,false);
 assert.equal(r.canReplay,false);
});
