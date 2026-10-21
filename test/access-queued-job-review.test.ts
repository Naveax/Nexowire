import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {installedBrokerSigningBytes,type InstalledBrokerNonceRecord}
  from '../src/product/access-native-broker-proof.js';
import {
  casReadbackSigningBytes,reviewQueuedAccess,
  type CasReadbackRecord,type QueuedAccessRequest,
  type QueuedAccessDependencies,
} from '../src/product/access-queued-job-review.js';
import type {AccessEffectiveAuthority,EffectiveAccessStatus}
  from '../src/product/access-effective-authority.js';
import type {ProductDeviceRecord} from '../src/product/control-plane-store.js';

const keys=generateKeyPairSync('ed25519');
const forgedKeys=generateKeyPairSync('ed25519');
const brokerKeys=generateKeyPairSync('ed25519');
const brokerIdentity={
  pid:8123,creationFiletime:'134092000001239777',
  volumeSerialHex:'a0b1c2d3',imageFileIdHex:'ab'.repeat(16),
  imageSha256:'c'.repeat(64),brokerVersion:'1.0.5',
};
const t0=Date.parse('2026-10-21T19:00:00.000Z');
const ids={
  authority:randomUUID(),request:randomUUID(),owner:randomUUID(),
  device:randomUUID(),deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
};
const credentialHash='a'.repeat(64);
const sessionHash='b'.repeat(64);
const device={
  id:ids.device,ownerAccountId:ids.owner,credentialHash,
  platform:'win32',accessMode:'full',online:true,privilegeMode:'broker',
  adminBridgeReady:true,
} as ProductDeviceRecord;
const session={
  ownerAccountId:ids.owner,sessionHash,
  sessionExpiresAt:'2026-10-21T20:00:00.000Z',loginIsRevoked:false,
};
function queued(patch:Partial<QueuedAccessRequest>={}):QueuedAccessRequest{
  return {
    mode:'CORE',requestId:ids.request,deviceId:ids.device,
    ownerId:ids.owner,deviceEpoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
    ownerEpoch:8,grantGeneration:9,credentialHash,sessionHash,
    rootIssuedAt:null,rootExpiresAt:null,effectState:'queued',
    cachedUiEffective:true,...patch,
  };
}
function record(job:QueuedAccessRequest,nonce:string):CasReadbackRecord{
  return {
    kind:'nexowire.access.cas-readback.v1',
    authorityId:ids.authority,
    requestId:job.requestId,challengeNonce:nonce,
    deviceId:job.deviceId,ownerId:job.ownerId,
    deviceEpoch:job.deviceEpoch,sessionEpoch:job.sessionEpoch,
    ownerEpoch:job.ownerEpoch,grantGeneration:job.grantGeneration,
    privilege:job.mode,revoked:false,
    observedAtMs:t0,expiresAtMs:t0+4000,
  };
}
function nativeRecord(job:QueuedAccessRequest,nonce:string):InstalledBrokerNonceRecord{
  return {
    kind:'nexowire.access.installed-broker-nonce.v1',
    source:'protected-installed-broker-process',
    requestId:job.requestId,challengeNonce:nonce,
    deviceId:job.deviceId,ownerId:job.ownerId,
    deviceEpoch:job.deviceEpoch,sessionEpoch:job.sessionEpoch,
    ownerEpoch:job.ownerEpoch,grantGeneration:job.grantGeneration,
    privilege:job.mode,brokerPid:brokerIdentity.pid,
    creationFiletime:brokerIdentity.creationFiletime,
    volumeSerialHex:brokerIdentity.volumeSerialHex,
    imageFileIdHex:brokerIdentity.imageFileIdHex,
    imageSha256:brokerIdentity.imageSha256,
    brokerVersion:brokerIdentity.brokerVersion,
    nativeTokenIntegrity:'high',enabledAdministrators:true,
    publisherAndReleasePinned:true,
    protectedParentImportUpdaterTree:true,
    processDupHandleBoundaryVerified:true,
    observedAtMs:t0,expiresAtMs:t0+4000,
  };
}
const positive:EffectiveAccessStatus={
  requestedMode:'CORE',state:'EFFECTIVE',effective:true,
  verifiedNativeHighToken:true,
  authoritySource:'independent-protected-windows-broker',
  localEnrollmentVerified:true,actualElevatedTokenVerified:true,
  brokerSourceAclVerified:true,brokerVersionVerified:true,
  requiresPerCommandUac:false,canDispatch:false,reason:'FIXTURE_ONLY',
};
function fixture(options:{
  positiveStatus?:boolean;
  casRevoked?:boolean;
  externalOwnerEpoch?:number;
  externalGeneration?:number;
  currentOwnerEpoch?:number;
  currentGeneration?:number;
  currentOwnerId?:string;
  currentDeviceEpoch?:string;
  currentSessionEpoch?:string;
  signingKey?:typeof keys.privateKey;
  nativeSigningKey?:typeof brokerKeys.privateKey;
  nativeProofUnavailable?:boolean;
  nativePinnedProcess?:Partial<typeof brokerIdentity>;
  nativePinnedKey?:typeof brokerKeys.publicKey;
  mutateNative?:(record:InstalledBrokerNonceRecord)=>InstalledBrokerNonceRecord;
  mutateReadback?:(record:CasReadbackRecord)=>CasReadbackRecord;
  readThrows?:boolean;
  highWaterThrows?:boolean;
  clock?:number;
  clockSequence?:number[];
}={}){
  let projected=0,read=0,high=0,tick=0;
  const dependencies:QueuedAccessDependencies={
    authorityId:ids.authority,
    independentCasPublicKey:keys.publicKey,
    installedBroker:{
      publicKey:options.nativePinnedKey??brokerKeys.publicKey,
      process:{...brokerIdentity,...options.nativePinnedProcess},
    },
    readInstalledBroker:async(job,nonce)=>{
      if(options.nativeProofUnavailable)throw Error('NATIVE_BROKER_UNAVAILABLE');
      const baseline=nativeRecord(job,nonce);
      const raw=options.mutateNative?.(baseline)??baseline;
      // Invalid native token claims are still returned as hostile data;
      // the fixture must not throw before exercising the Access parser.
      let bytes:Buffer;
      try{bytes=installedBrokerSigningBytes(raw)}
      catch{bytes=installedBrokerSigningBytes(baseline)}
      return {statement:raw,signature:sign(null,bytes,
        options.nativeSigningKey??brokerKeys.privateKey).toString('base64url')};
    },
    effectiveAuthority:{
      project:async()=>{projected++;return options.positiveStatus===false?
        {...positive,effective:false,state:'PAUSED_UNVERIFIED' as const,
          authoritySource:'none' as const,actualElevatedTokenVerified:false}:positive;
      },
    } as unknown as AccessEffectiveAuthority,
    readCas:async(job,nonce)=>{
      read++;
      if(options.readThrows)throw Error('CAS_UNAVAILABLE');
      const data={...record(job,nonce),revoked:options.casRevoked??false,
        ownerEpoch:options.externalOwnerEpoch??job.ownerEpoch,
        grantGeneration:options.externalGeneration??job.grantGeneration};
      const output=options.mutateReadback?.(data)??data;
      const bytes=casReadbackSigningBytes(output);
      return {statement:output,signature:sign(null,bytes,
        options.signingKey??keys.privateKey).toString('base64url')};
    },
    readHighWater:async()=>{
      high++;
      if(options.highWaterThrows)throw Error('CAS_HIGHWATER_UNAVAILABLE');
      return {
        ownerId:options.currentOwnerId??ids.owner,
        deviceEpoch:options.currentDeviceEpoch??ids.deviceEpoch,
        sessionEpoch:options.currentSessionEpoch??ids.sessionEpoch,
        ownerEpoch:options.currentOwnerEpoch??8,
        grantGeneration:options.currentGeneration??9,
      };
    },
    now:()=>options.clockSequence?.[tick++]??options.clock??t0,
  };
  const ctx={device,session,corePreferenceEnabled:true,
    bridgeDesiredMode:'auto' as const};
  return {dependencies,ctx,calls:()=>({projected,read,high})};
}

test('fresh signed CAS readback is a REVIEW, never dispatch authorization or UAC prompt',async()=>{
 const f=fixture();
 const result=await reviewQueuedAccess(queued(),f.ctx,f.dependencies);
 assert.equal(result.status,'REVIEWED_ONLY_NO_DISPATCH');
 assert.equal(result.elevatedDispatchAllowed,false);
 assert.equal(result.noAdditionalPerCommandUacAfterBootstrap,true);
 assert.equal(result.cachedUiTrusted,false);
 assert.equal(result.canRetry,false);
 assert.deepEqual(f.calls(),{projected:1,read:1,high:1});
});

test('cached UI EFFECTIVE, Agent ready, and an old receipt cannot overcome fresh revoked CORE',async()=>{
 const f=fixture({positiveStatus:false});
 const result=await reviewQueuedAccess(queued({cachedUiEffective:true}),f.ctx,f.dependencies);
 assert.equal(result.status,'DENIED');
 assert.equal(result.reason,'FRESH_BROKER_OR_OWNER_PROOF_MISSING');
 assert.deepEqual(f.calls(),{projected:1,read:0,high:0});
 const fakeUi=fixture({casRevoked:true});
 assert.equal((await reviewQueuedAccess(queued(),fakeUi.ctx,fakeUi.dependencies)).status,'DENIED');
});

test('stale owner, re-pair device credential/session epoch and changed owner deny',async()=>{
 const patchers=[
  {ownerId:randomUUID()},
  {deviceId:randomUUID()},
  {credentialHash:'c'.repeat(64)},
  {sessionHash:'d'.repeat(64)},
 ];
 for(const p of patchers){
  const f=fixture();
  const result=await reviewQueuedAccess(queued(p),f.ctx,f.dependencies);
  assert.equal(result.status,'DENIED');
  assert.equal(f.calls().projected,0);
 }
 const f=fixture({currentOwnerEpoch:10});
 assert.equal((await reviewQueuedAccess(queued(),f.ctx,f.dependencies)).status,'DENIED');
 const repaired=fixture({externalOwnerEpoch:11});
 assert.equal((await reviewQueuedAccess(queued(),repaired.ctx,repaired.dependencies)).status,'DENIED');
 const staleSession=fixture();
 assert.equal((await reviewQueuedAccess(queued(),
   {...staleSession.ctx,session:{...session,loginIsRevoked:true}},
   staleSession.dependencies)).status,'DENIED');
});

test('CORE revoked while queued or awaiting continuation rejects fresh next side-effect',async()=>{
 const before=fixture();
 assert.equal((await reviewQueuedAccess(queued(),before.ctx,before.dependencies)).status,
   'REVIEWED_ONLY_NO_DISPATCH');
 const after=fixture({currentGeneration:10});
 const result=await reviewQueuedAccess(queued(),after.ctx,after.dependencies);
 assert.equal(result.status,'DENIED');
 assert.equal(result.reason,'INDEPENDENT_CAS_HIGHWATER_ADVANCED');
 assert.equal(result.elevatedDispatchAllowed,false);
 const external=fixture({externalGeneration:10});
 assert.equal((await reviewQueuedAccess(queued(),external.ctx,external.dependencies)).status,'DENIED');
});

test('possible side effect after revoke is UNKNOWN, not replayed, without any remote read',async()=>{
 const f=fixture({highWaterThrows:true});
 const result=await reviewQueuedAccess(queued({effectState:'may-have-dispatched'}),f.ctx,f.dependencies);
 assert.equal(result.status,'UNKNOWN_RECONCILE');
 assert.equal(result.reason,'POSSIBLE_EFFECT_NO_REPLAY');
 assert.equal(result.canRetry,false);
 assert.deepEqual(f.calls(),{projected:0,read:0,high:0});
});

test('ROOT permission expires at exactly 15-minute boundary despite cached EFFECTIVE',async()=>{
 const issued=t0-900_000;
 const expires=t0;
 const f=fixture({clock:t0});
 const root=queued({mode:'ROOT',
    rootIssuedAt:new Date(issued).toISOString(),
    rootExpiresAt:new Date(expires).toISOString()});
 const result=await reviewQueuedAccess(root,f.ctx,f.dependencies);
 assert.equal(result.status,'DENIED');
 assert.equal(result.reason,'ROOT_15M_EXPIRED_OR_UNBOUND');
 assert.equal(f.calls().projected,0);
 const stillValid=fixture({clock:t0-1});
 const max15=queued({mode:'ROOT',
    rootIssuedAt:new Date(issued).toISOString(),
    rootExpiresAt:new Date(expires).toISOString()});
 assert.equal((await reviewQueuedAccess(max15,stillValid.ctx,stillValid.dependencies)).status,
   'REVIEWED_ONLY_NO_DISPATCH');
 const longer=fixture({clock:t0-1});
 const over=queued({mode:'ROOT',
    rootIssuedAt:new Date(issued-1).toISOString(),
    rootExpiresAt:new Date(expires).toISOString()});
 assert.equal((await reviewQueuedAccess(over,longer.ctx,longer.dependencies)).status,'DENIED');
});

test('forged external CAS signature, expired readback and wrong authority fail closed',async()=>{
 for(const p of [
  {signingKey:forgedKeys.privateKey},
  {clock:t0+5001},
  {highWaterThrows:true},
  {readThrows:true},
 ]){
  const f=fixture(p);
  const result=await reviewQueuedAccess(queued(),f.ctx,f.dependencies);
  assert.equal(result.status,'DENIED');
  assert.equal(result.elevatedDispatchAllowed,false);
 }
});

test('signed stale re-pair epoch, foreign owner/device and alien CAS authority reject',async()=>{
 const tamper: Array<(r:CasReadbackRecord)=>CasReadbackRecord>=[
   r=>({...r,deviceEpoch:randomUUID()}),
   r=>({...r,sessionEpoch:randomUUID()}),
   r=>({...r,ownerId:randomUUID()}),
   r=>({...r,deviceId:randomUUID()}),
   r=>({...r,authorityId:randomUUID()}),
   r=>({...r,requestId:randomUUID()}),
   r=>({...r,privilege:'ROOT'}),
   r=>({...r,expiresAtMs:t0-1}),
 ];
 for(const mutateReadback of tamper){
   const f=fixture({mutateReadback});
   const result=await reviewQueuedAccess(queued(),f.ctx,f.dependencies);
   assert.equal(result.status,'DENIED');
   assert.equal(result.elevatedDispatchAllowed,false);
 }
});

test('queued revoke while CAS response pending denies at external high-water readback',async()=>{
 let release!:()=>void;
 const gate=new Promise<void>(r=>{release=r});
 const f=fixture();
 const original=f.dependencies.readCas;
 f.dependencies.readCas=async (job,nonce)=>{
   await gate;
   return original(job,nonce);
 };
 let generation=9;
 f.dependencies.readHighWater=async()=>({
   ownerId:ids.owner,deviceEpoch:ids.deviceEpoch,
   sessionEpoch:ids.sessionEpoch,ownerEpoch:8,grantGeneration:generation,
 });
 const outstanding=reviewQueuedAccess(queued(),f.ctx,f.dependencies);
 generation=10; // External #702 revoke/re-pair fencing advances before readback.
 release();
 const result=await outstanding;
 assert.equal(result.status,'DENIED');
 assert.equal(result.reason,'INDEPENDENT_CAS_HIGHWATER_ADVANCED');
 assert.equal(result.canRetry,false);
});

test('no proof grants a real high Broker token or dispatch, even all synthetic booleans true',async()=>{
 const f=fixture();
 const r=await reviewQueuedAccess(queued(),f.ctx,f.dependencies);
 assert.equal(r.elevatedDispatchAllowed,false);
 assert.equal(r.cachedUiTrusted,false);
 assert.equal('brokerInstalled' in r,false);
});


test('old signed #712-style CAS claim and native token proof cannot replay across nonce',async()=>{
 for(const tamper of [
   {mutateReadback:(r:CasReadbackRecord)=>({...r,challengeNonce:'f'.repeat(64)})},
   {mutateNative:(r:InstalledBrokerNonceRecord)=>({...r,challengeNonce:'e'.repeat(64)})},
 ]){
   const f=fixture(tamper);
   const result=await reviewQueuedAccess(queued(),f.ctx,f.dependencies);
   assert.equal(result.status,'DENIED');
   assert.equal(result.elevatedDispatchAllowed,false);
 }
});

test('installed signed Broker PID creation FILETIME image ID and updater ancestry are mandatory',async()=>{
 const modified:Array<(r:InstalledBrokerNonceRecord)=>InstalledBrokerNonceRecord>=[
  r=>({...r,brokerPid:r.brokerPid+1}),
  r=>({...r,creationFiletime:'134092000001239778'}),
  r=>({...r,volumeSerialHex:'12345678'}),
  r=>({...r,imageFileIdHex:'ac'.repeat(16)}),
  r=>({...r,imageSha256:'d'.repeat(64)}),
  r=>({...r,brokerVersion:'1.0.4'}),
  r=>({...r,ownerEpoch:r.ownerEpoch+1}),
  r=>({...r,deviceEpoch:randomUUID()}),
  r=>({...r,sessionEpoch:randomUUID()}),
  r=>({...r,enabledAdministrators:false as true}),
  r=>({...r,processDupHandleBoundaryVerified:false as true}),
  r=>({...r,protectedParentImportUpdaterTree:false as true}),
  r=>({...r,publisherAndReleasePinned:false as true}),
 ];
 for(const mutateNative of modified){
   const f=fixture({mutateNative});
   const result=await reviewQueuedAccess(queued(),f.ctx,f.dependencies);
   assert.equal(result.status,'DENIED',String(mutateNative));
   assert.equal(result.reason,'INSTALLED_BROKER_NONCE_TOKEN_UNVERIFIED');
 }
});

test('self-inspecting PowerShell token, forged native signature or missing installed provider are denied',async()=>{
 const scenarios=[
   {nativeSigningKey:forgedKeys.privateKey},
   {nativeProofUnavailable:true},
   {nativePinnedProcess:{creationFiletime:'134092000001239778'}},
   {nativePinnedProcess:{imageFileIdHex:'ee'.repeat(16)}},
   {nativePinnedProcess:{imageSha256:'ff'.repeat(64)}},
 ];
 for(const options of scenarios){
   const f=fixture(options);
   const result=await reviewQueuedAccess(queued(),f.ctx,f.dependencies);
   assert.equal(result.status,'DENIED');
   assert.equal(result.elevatedDispatchAllowed,false);
 }
 // #709's test PowerShell token can never sign as the installed Broker.
 const f=fixture();
 f.dependencies.readInstalledBroker=async (job,nonce)=>{
   const valid=nativeRecord(job,nonce);
   return {statement:{...valid,source:'own-inspecting-powershell-token'},
     signature:sign(null,installedBrokerSigningBytes(valid),
       brokerKeys.privateKey).toString('base64url')};
 };
 const result=await reviewQueuedAccess(queued(),f.ctx,f.dependencies);
 assert.equal(result.status,'DENIED');
 assert.equal(result.reason,'INSTALLED_BROKER_NONCE_TOKEN_UNVERIFIED');
});

test('native and external CAS authority must have independent pinned signers',async()=>{
 const f=fixture({nativePinnedKey:keys.publicKey,nativeSigningKey:keys.privateKey});
 const result=await reviewQueuedAccess(queued(),f.ctx,f.dependencies);
 assert.equal(result.status,'DENIED');
 assert.equal(result.reason,'BROKER_CAS_SIGNING_KEYS_NOT_INDEPENDENT');
});

test('reconnect must have current independently read owner/device/session epoch even if signed old CAS is green',async()=>{
 for(const patch of [
  {currentOwnerId:randomUUID()},
  {currentDeviceEpoch:randomUUID()},
  {currentSessionEpoch:randomUUID()},
 ]){
   const f=fixture(patch);
   const result=await reviewQueuedAccess(queued(),f.ctx,f.dependencies);
   assert.equal(result.status,'DENIED');
   assert.equal(result.reason,'INDEPENDENT_CAS_HIGHWATER_ADVANCED');
 }
});

test('ROOT expiry while waiting for fresh nonce-bound witnesses denies after second clock check',async()=>{
 const f=fixture({clockSequence:[t0-1,t0]});
 const job=queued({mode:'ROOT',
   rootIssuedAt:new Date(t0-900_000).toISOString(),
   rootExpiresAt:new Date(t0).toISOString(),
 });
 const result=await reviewQueuedAccess(job,f.ctx,f.dependencies);
 assert.equal(result.status,'DENIED');
 assert.equal(result.reason,'ROOT_OR_READBACK_EXPIRED_DURING_REVIEW');
 assert.equal(result.noAdditionalPerCommandUacAfterBootstrap,true);
 assert.equal(result.elevatedDispatchAllowed,false);
});
