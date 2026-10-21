import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
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
function record(job:QueuedAccessRequest):CasReadbackRecord{
  return {
    kind:'nexowire.access.cas-readback.v1',
    authorityId:ids.authority,
    requestId:job.requestId,
    deviceId:job.deviceId,ownerId:job.ownerId,
    deviceEpoch:job.deviceEpoch,sessionEpoch:job.sessionEpoch,
    ownerEpoch:job.ownerEpoch,grantGeneration:job.grantGeneration,
    privilege:job.mode,revoked:false,
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
  signingKey?:typeof keys.privateKey;
  mutateReadback?:(record:CasReadbackRecord)=>CasReadbackRecord;
  readThrows?:boolean;
  highWaterThrows?:boolean;
  clock?:number;
}={}){
  let projected=0,read=0,high=0;
  const dependencies:QueuedAccessDependencies={
    authorityId:ids.authority,
    independentCasPublicKey:keys.publicKey,
    effectiveAuthority:{
      project:async()=>{projected++;return options.positiveStatus===false?
        {...positive,effective:false,state:'PAUSED_UNVERIFIED' as const,
          authoritySource:'none' as const,actualElevatedTokenVerified:false}:positive;
      },
    } as unknown as AccessEffectiveAuthority,
    readCas:async(job)=>{
      read++;
      if(options.readThrows)throw Error('CAS_UNAVAILABLE');
      const data={...record(job),revoked:options.casRevoked??false,
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
        ownerEpoch:options.currentOwnerEpoch??8,
        grantGeneration:options.currentGeneration??9,
      };
    },
    now:()=>options.clock??t0,
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
 f.dependencies.readCas=async job=>{
   await gate;
   return original(job);
 };
 let generation=9;
 f.dependencies.readHighWater=async()=>({
   ownerEpoch:8,grantGeneration:generation,
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
