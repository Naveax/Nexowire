/**
 * #18 hostile SOURCE-ONLY QA for #702 Broker dispatch fence. Two gate
 * instances are NOT physical Windows Brokers. The remote authority below
 * is an in-memory, serializable contract model, NOT non-restorable CAS.
 * No live Agent, external PostgreSQL, privileged token, OS mutation or VM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign,type KeyObject} from 'node:crypto';
import {mkdtemp,rm,copyFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync,backup} from 'node:sqlite';
import {BrokerExternalDispatchFence,
  type ExternalBrokerDispatchAuthority,type BrokerDispatchRequest,
  type ProtectedBrokerEvidence,type DispatchClaim,type DispatchRevokeRequest}
 from '../src/agent/broker-external-dispatch-fence.js';
import {signedOperatorGrantVerifier}
 from '../src/agent/witness-signed-provenance.js';

const fp='d'.repeat(64);
const ack=(value:unknown,key:KeyObject):DispatchClaim=>{
 const bytes=Buffer.from(JSON.stringify(value));
 return {payload:bytes.toString('base64url'),
  signature:sign(null,bytes,key).toString('base64url')};
};
function latch(){
 let signal!:()=>void;
 const promise=new Promise<void>(resolve=>{signal=resolve});
 return {promise,signal};
}
class HostileDispatchCAS implements ExternalBrokerDispatchAuthority{
 generation=7;
 ownerId:string;deviceId:string;deviceEpoch:string;sessionEpoch:string;
 revoked=false;revoking=false;coreEnabled=true;
 readonly active=new Set<string>();
 readonly claimed=new Map<string,DispatchClaim>();
 readonly released=new Set<string>();
 readonly enteredReserve=latch();
 readonly releaseReserve=latch();
 pauseOneReserve=false;
 readonly revokeStall=latch();
 readonly revokeEntered=latch();
 readonly allowRevoke=latch();
 stalledRevoke=false;
 loseRevokeAck=false;
 loseReleaseAck=false;
 replaySignedPermit=false;
 missingReleaseBlocks=false; // Fixture can demonstrate absent durable remote quarantine.
 lastClaim?:DispatchClaim;
 private readonly drained:Array<()=>void>=[];
 constructor(readonly authorityId:string,readonly brokerId:string,
  readonly signer:KeyObject,ident:{
   ownerId:string;deviceId:string;deviceEpoch:string;sessionEpoch:string
  }){
  this.ownerId=ident.ownerId;this.deviceId=ident.deviceId;
  this.deviceEpoch=ident.deviceEpoch;this.sessionEpoch=ident.sessionEpoch;
 }
 snapshot(){
  return {generation:this.generation,ownerId:this.ownerId,
   deviceEpoch:this.deviceEpoch,sessionEpoch:this.sessionEpoch,
   revoked:this.revoked,revoking:this.revoking,
   coreEnabled:this.coreEnabled,
   claimed:new Map(this.claimed)};
 }
 restoreUnsafe(s:ReturnType<HostileDispatchCAS['snapshot']>){
  this.generation=s.generation;this.ownerId=s.ownerId;
  this.deviceEpoch=s.deviceEpoch;this.sessionEpoch=s.sessionEpoch;
  this.revoked=s.revoked;this.revoking=s.revoking;this.coreEnabled=s.coreEnabled;
  this.claimed.clear();
  for(const [id,claim] of s.claimed)this.claimed.set(id,claim);
 }
 async beginIfCurrent(op:BrokerDispatchRequest,
  broker:ProtectedBrokerEvidence):Promise<DispatchClaim>{
  if(this.pauseOneReserve){
   this.pauseOneReserve=false;
   this.enteredReserve.signal();
   await this.releaseReserve.promise;
  }
  if(this.replaySignedPermit&&this.lastClaim)return this.lastClaim;
  const x=op.scope;
  if(this.revoked||this.revoking||!this.coreEnabled||
     x.ownerId!==this.ownerId||x.deviceId!==this.deviceId||
     x.deviceEpoch!==this.deviceEpoch||x.sessionEpoch!==this.sessionEpoch||
     x.expectedGeneration!==this.generation||
     this.claimed.has(op.requestId))
    throw Error('SIMULATED_ATOMIC_FENCE_DENIED');
  const now=Date.now(),dispatchId=randomUUID();
  const permit=ack({kind:'broker_dispatch_permit_v1',
   authorityId:this.authorityId,brokerId:broker.brokerId,dispatchId,
   requestId:op.requestId,fingerprint:op.fingerprint,capability:op.capability,
   ownerId:x.ownerId,deviceId:x.deviceId,deviceEpoch:x.deviceEpoch,
   sessionEpoch:x.sessionEpoch,generation:x.expectedGeneration,
   privilege:x.requiredPrivilege,issuedAtMs:now,expiresAtMs:now+2500},this.signer);
  this.claimed.set(op.requestId,permit);
  this.active.add(dispatchId);this.lastClaim=permit;
  return permit;
 }
 async release(dispatchId:string):Promise<void>{
  this.released.add(dispatchId);this.active.delete(dispatchId);
  if(this.active.size===0){
   for(const finish of this.drained.splice(0))finish();
  }
  if(this.loseReleaseAck)throw Error('SIMULATED_RELEASE_ACK_LOST');
 }
 async revokeAndDrain(r:DispatchRevokeRequest):Promise<DispatchClaim>{
  if(this.revoked||this.revoking||r.ownerId!==this.ownerId||
     r.deviceId!==this.deviceId||r.deviceEpoch!==this.deviceEpoch||
     r.sessionEpoch!==this.sessionEpoch||r.expectedGeneration!==this.generation)
    throw Error('SIMULATED_STALE_REVOKE');
  this.revoking=true;
  this.revokeEntered.signal();
  if(this.stalledRevoke)await this.allowRevoke.promise;
  if(this.active.size){
   await new Promise<void>(resolve=>{this.drained.push(resolve)});
  }
  const old=this.generation;
  this.revoked=true;this.generation++;
  if(this.loseRevokeAck)throw Error('SIMULATED_COMMITTED_REVOKE_ACK_LOST');
  return ack({kind:'broker_dispatch_revocation_v1',
   authorityId:this.authorityId,deviceId:this.deviceId,ownerId:this.ownerId,
   deviceEpoch:this.deviceEpoch,sessionEpoch:this.sessionEpoch,
   previousGeneration:old,generation:this.generation,
   drained:true,revoked:true},this.signer);
 }
 // Synthetic external transition ONLY: #702 has no rePair dispatch endpoint.
 rePairSynthetic(input:{owner:string;epoch:string;session:string}){
  this.ownerId=input.owner;this.deviceEpoch=input.epoch;
  this.sessionEpoch=input.session;this.generation++;
  this.coreEnabled=false;this.revoked=false;this.revoking=false;
 }
}
function fixture(){
 const ids={authorityId:randomUUID(),brokerId:randomUUID(),
  ownerId:randomUUID(),deviceId:randomUUID(),
  deviceEpoch:randomUUID(),sessionEpoch:randomUUID()};
 const signer=generateKeyPairSync('ed25519');
 const ownerKeys=generateKeyPairSync('ed25519');
 const verifyOwner=signedOperatorGrantVerifier(
  ownerKeys.publicKey.export({type:'spki',format:'pem'}).toString());
 const remote=new HostileDispatchCAS(ids.authorityId,ids.brokerId,
  signer.privateKey,ids);
 const request=(id=randomUUID()):BrokerDispatchRequest=>({
  requestId:id,fingerprint:fp,capability:'files.write',
  scope:{ownerId:ids.ownerId,deviceId:ids.deviceId,
   deviceEpoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
   expectedGeneration:7,requiredPrivilege:'CORE'},
 });
 const revoke=():DispatchRevokeRequest=>{
  const intent={kind:'revoke',authorityId:ids.authorityId,
   deviceId:ids.deviceId,ownerId:ids.ownerId,epoch:ids.deviceEpoch,
   sessionEpoch:ids.sessionEpoch,generation:7};
  const signedOwnerApproval=JSON.stringify(ack({
   version:1,intent,nonce:randomUUID(),
   issuedAt:Date.now()-1000,expiresAt:Date.now()+60_000,
  },ownerKeys.privateKey));
  return {deviceId:ids.deviceId,ownerId:ids.ownerId,
   deviceEpoch:ids.deviceEpoch,sessionEpoch:ids.sessionEpoch,
   expectedGeneration:7,signedOwnerApproval};
 };
 const gate=()=>new BrokerExternalDispatchFence({
  authority:remote,authorityId:ids.authorityId,
  publicKeyPem:signer.publicKey.export({type:'spki',format:'pem'}).toString(),
  verifyIdentity:async()=>true,
  // TEST ONLY synthetic high-token evidence; not an actual Windows token.
  verifyEffectiveBroker:async()=>({verified:true,brokerId:ids.brokerId,
   highIntegrityToken:true,signedProtectedImage:true,
   protectedParentAndImports:true}),
  verifyOwnerRevocation:async r=>verifyOwner({
   kind:'revoke',authorityId:ids.authorityId,deviceId:ids.deviceId,
   ownerId:ids.ownerId,epoch:ids.deviceEpoch,
   sessionEpoch:ids.sessionEpoch,generation:r.expectedGeneration,
  },r.signedOwnerApproval),
 });
 return {ids,remote,request,revoke,gate};
}
const deny=(promise:Promise<unknown>,code:string)=>
 assert.rejects(promise,{code});

test('#18 #702 two gates: revokeAndDrain waits for admitted lease, rejects competing reserve',async()=>{
 const f=fixture(),a=f.gate(),b=f.gate(),finished=latch(),entered=latch();
 let effects=0;
 const first=a.execute(f.request(),async()=>{
  effects++;entered.signal();await finished.promise;return 'DONE';
 });
 await entered.promise;
 const pending=b.revoke(f.revoke());
 await f.remote.revokeEntered.promise;
 assert.equal(f.remote.revoking,true);
 assert.equal(f.remote.revoked,false);
 await deny(a.execute(f.request(),async()=>{effects++;}),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 await deny(b.execute(f.request(),async()=>{effects++;}),
  'DISPATCH_REVOKE_PENDING');
 assert.equal(effects,1);
 finished.signal();
 assert.equal(await first,'DONE');
 const receipt=await pending;
 assert.equal(receipt.drained,true);
 assert.equal(f.remote.active.size,0);
 assert.equal(f.remote.revoked,true);
 assert.equal(f.remote.generation,8);
 await deny(f.gate().execute(f.request(),async()=>{effects++;}),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 assert.equal(effects,1);
});

test('#18 #702 reserve suspended before external commit loses to revoked generation',async()=>{
 const f=fixture(),a=f.gate(),b=f.gate();
 f.remote.pauseOneReserve=true;
 let effects=0;
 const candidate=a.execute(f.request(),async()=>{effects++;});
 await f.remote.enteredReserve.promise;
 const revoke=await b.revoke(f.revoke());
 assert.equal(revoke.generation,8);
 f.remote.releaseReserve.signal();
 await deny(candidate,'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 assert.equal(effects,0);
 assert.equal(f.remote.claimed.size,0);
});

test('#18 #702 stalled revoke local fence + external fence defeats second gate and signed old owner',async()=>{
 const f=fixture(),a=f.gate(),b=f.gate();
 f.remote.stalledRevoke=true;
 let effects=0;
 const pending=a.revoke(f.revoke());
 await f.remote.revokeEntered.promise;
 await deny(a.execute(f.request(),async()=>{effects++;}),
  'DISPATCH_REVOKE_PENDING');
 await deny(b.execute(f.request(),async()=>{effects++;}),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 assert.equal(effects,0);
 f.remote.allowRevoke.signal();
 assert.equal((await pending).generation,8);
 await deny(f.gate().execute(f.request(),async()=>{effects++;}),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 assert.equal(effects,0);
});

test('#18 #702 committed revoke lost ACK and rebooted other gate must query external fence',async()=>{
 const f=fixture(),a=f.gate();
 f.remote.loseRevokeAck=true;
 await deny(a.revoke(f.revoke()),'DISPATCH_REVOKE_OUTCOME_UNKNOWN');
 assert.equal(f.remote.revoked,true);
 assert.equal(f.remote.generation,8);
 let effects=0;
 await deny(a.execute(f.request(),async()=>{effects++;}),
  'DISPATCH_REVOKE_PENDING');
 await deny(f.gate().execute(f.request(),async()=>{effects++;}),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 assert.equal(effects,0);
});

test('#18 #702 synthetic re-pair after revoke clears CORE, stale owner/epoch/session cannot dispatch',async()=>{
 const f=fixture(),original=f.gate();
 const historical=f.request();
 assert.equal(await original.execute(historical,async()=>1),1);
 const next={owner:randomUUID(),epoch:randomUUID(),session:randomUUID()};
 f.remote.rePairSynthetic(next);
 let effects=0;
 await deny(f.gate().execute(f.request(),async()=>{effects++;}),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 const migrated:BrokerDispatchRequest={...f.request(),
  scope:{...f.request().scope,ownerId:next.owner,
   deviceEpoch:next.epoch,sessionEpoch:next.session,
   expectedGeneration:8}};
 await deny(f.gate().execute(migrated,async()=>{effects++;}),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 assert.equal(f.remote.coreEnabled,false);
 assert.equal(f.remote.claimed.size,1);
 assert.equal(effects,0);
});

test('#18 #702 two independent gates: only externally unique requestId prevents duplicate',async()=>{
 const f=fixture(),a=f.gate(),b=f.gate(),op=f.request();
 let effects=0;
 assert.equal(await a.execute(op,async()=>++effects),1);
 await deny(b.execute(op,async()=>++effects),'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 assert.equal(effects,1);
 assert.equal(f.remote.claimed.size,1);
});

test('#18 #702 NEGATIVE: signed permit replay on a second gate is accepted if external CAS violates single-use',async()=>{
 const f=fixture(),a=f.gate(),b=f.gate(),op=f.request();
 let effects=0;
 assert.equal(await a.execute(op,async()=>++effects),1);
 f.remote.replaySignedPermit=true;
 // Deliberate hostile authority: returns the SAME genuine short-lived
 // signed claim ID for the SAME requestId to a different Broker instance.
 // This is UNSAFE and must never be presented as physical acceptance.
 assert.equal(await b.execute(op,async()=>++effects),2);
 assert.equal(effects,2);
 assert.equal(f.remote.claimed.size,1);
});

test('#18 #702 TEMP WAL rollback shows old local active row but new gate still denies revoked external epoch',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nexowire-qa18-broker-wal-'));
 t.after(async()=>{await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:50});});
 const file=path.join(root,'synthetic.sqlite'),old=path.join(root,'old.sqlite');
 const db=new DatabaseSync(file);
 try{
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; '+
   'CREATE TABLE grants(device TEXT PRIMARY KEY,active INTEGER);');
  const f=fixture(),a=f.gate();
  db.prepare('INSERT INTO grants VALUES(?,1)').run(f.ids.deviceId);
  await backup(db,old);
  await a.revoke(f.revoke());
  db.prepare('UPDATE grants SET active=0 WHERE device=?').run(f.ids.deviceId);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  await copyFile(old,file);
  const restored=new DatabaseSync(file,{readOnly:true});
  try{
   assert.equal((restored.prepare('SELECT active FROM grants WHERE device=?')
    .get(f.ids.deviceId) as {active:number}).active,1);
  }finally{restored.close();}
  let effects=0;
  await deny(f.gate().execute(f.request(),async()=>{effects++;}),
   'DISPATCH_EXTERNAL_CAS_UNKNOWN');
  assert.equal(effects,0);
 }finally{try{db.close()}catch{}}
});

test('#18 #702 NEGATIVE: restoring the EXTERNAL witness itself resurrects revoked generation',async()=>{
 const f=fixture(),old=f.remote.snapshot();
 assert.equal((await f.gate().revoke(f.revoke())).revoked,true);
 f.remote.restoreUnsafe(old);
 let effects=0;
 // Attacker co-restored authority state, not just local SQLite. This
 // intentionally passes to prove why non-restorable external custody is P0.
 assert.equal(await f.gate().execute(f.request(),async()=>++effects),1);
 assert.equal(effects,1);
});

test('#18 #702 lost release ACK fences local gate; new gate needs durable remote uncertainty',async()=>{
 const f=fixture(),a=f.gate();
 f.remote.loseReleaseAck=true;
 let effects=0;
 assert.equal(await a.execute(f.request(),async()=>++effects),1);
 await deny(a.execute(f.request(),async()=>++effects),
  'DISPATCH_REVOKE_PENDING');
 assert.equal(effects,1);
 // The synthetic external authority confirmed release but lost response.
 // The new gate MUST still acquire a distinct online remote permit;
 // this is NOT a proof of idempotent effect or physical crash safety.
 assert.equal(await f.gate().execute(f.request(),async()=>++effects),2);
 assert.equal(f.remote.claimed.size,2);
});
