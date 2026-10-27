/** #01 Agent Journal P0 #587: SOURCE contract, not a real elevated broker.
 * FakeExternal is a deterministic CAS simulator (never production witness).
 * Ed25519 cryptographic signature verification is real Node crypto.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign,type KeyObject} from 'node:crypto';
import {mkdtemp,rm,copyFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {signedOperatorGrantVerifier} from '../src/agent/witness-signed-provenance.js';
import {BrokerExternalDispatchFence,type ExternalBrokerDispatchAuthority,
  type BrokerDispatchRequest,type DispatchClaim,
  type ProtectedBrokerEvidence,type DispatchRevokeRequest,
  type DispatchReleaseRequest}
 from '../src/agent/broker-external-dispatch-fence.js';

const fingerprint='a'.repeat(64);
const ownerKeys=generateKeyPairSync('ed25519');
const authorityKeys=generateKeyPairSync('ed25519');
const signClaim=(value:unknown,key:KeyObject=authorityKeys.privateKey):DispatchClaim=>{
 const bytes=Buffer.from(JSON.stringify(value));
 return {payload:bytes.toString('base64url'),
  signature:sign(null,bytes,key).toString('base64url')};
};
const keys=authorityKeys.publicKey.export({type:'spki',format:'pem'}).toString();
function deferred(){
 let resolve!:()=>void;
 const promise=new Promise<void>(r=>{resolve=r});
 return {promise,resolve};
}
class FakeRemoteCAS implements ExternalBrokerDispatchAuthority{
  readonly dispatched=new Map<string,string>();
  readonly active=new Set<string>();
  private readonly claimScopes=new Map<string,{
    request:BrokerDispatchRequest;brokerId:string}>();
  readonly released=new Set<string>();
  generation=7;
  ownerEpoch=4;
  owner:string;
  device:string;
  deviceEpoch:string;
  session:string;
  revoked=false;revoking=false;unknown=false;forged=false;
  staleSignature=false;claimReplay=false;releaseLost=false;
  loseRevokeAckAfterCommit=false;
  loseBeginAckAfterReservation=false;
  loseDispatchCommitAck=false;
  wrongSignedOwnerEpoch=false;
  lastClaim:DispatchClaim|undefined;
  private readonly drainWaiters:Array<()=>void>=[];
  readonly holdRevoke=deferred();
  readonly holdBeginResponse=deferred();
  readonly holdCommitResponse=deferred();
  commitEntered=false;
  commitCalls=0;
  stallRevoke=false;stallBeginResponse=false;stallCommitResponse=false;
  number=0;
  constructor(readonly authorityId:string,
    readonly brokerId:string,
    identity:{owner:string;device:string;epoch:string;session:string}){
    this.owner=identity.owner;this.device=identity.device;
    this.deviceEpoch=identity.epoch;this.session=identity.session;
  }
  readonly beginChallenges:string[]=[];
  async beginIfCurrent(op:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence,challengeNonce:string):Promise<DispatchClaim>{
    this.beginChallenges.push(challengeNonce);
    if(this.unknown)throw Error('EXTERNAL_TIMEOUT');
    if(this.claimReplay&&this.lastClaim)return this.lastClaim;
    const x=op.scope;
    if(this.revoked||this.revoking||x.ownerId!==this.owner||
       x.deviceId!==this.device||x.deviceEpoch!==this.deviceEpoch||
       x.sessionEpoch!==this.session||x.expectedGeneration!==this.generation||
       x.ownerEpoch!==this.ownerEpoch)
      throw Error('EXTERNAL_FENCE_DENIED');
    if(this.dispatched.has(op.requestId))throw Error('DISPATCH_REPLAY');
    const dispatchId=randomUUID();
    this.dispatched.set(op.requestId,dispatchId);this.active.add(dispatchId);
    this.claimScopes.set(dispatchId,{request:JSON.parse(JSON.stringify(op)) as
      BrokerDispatchRequest,brokerId:broker.brokerId});
    if(this.stallBeginResponse)await this.holdBeginResponse.promise;
    const now=Date.now();
    const permit=signClaim({kind:'broker_dispatch_permit_v1',
      authorityId:this.authorityId,
      brokerId:broker.brokerId,dispatchId,challengeNonce,
      requestId:op.requestId,fingerprint:op.fingerprint,
      capability:op.capability,
      ownerId:x.ownerId,deviceId:x.deviceId,deviceEpoch:x.deviceEpoch,
      sessionEpoch:x.sessionEpoch,
      ownerEpoch:this.wrongSignedOwnerEpoch?x.ownerEpoch+1:x.ownerEpoch,
      generation:x.expectedGeneration,
      privilege:x.requiredPrivilege,issuedAtMs:now,
      expiresAtMs:now+2500},this.forged
      ?generateKeyPairSync('ed25519').privateKey:authorityKeys.privateKey);
    this.lastClaim=permit;
    if(this.loseBeginAckAfterReservation){
      this.loseBeginAckAfterReservation=false;
      throw Error('BEGIN_ACK_LOST_AFTER_DURABLE_RESERVATION');
    }
    return permit;
  }
  async commitIfCurrent(op:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence,dispatchId:string,
    challengeNonce:string):Promise<DispatchClaim>{
    this.commitCalls++;
    const x=op.scope;
    // This is the second, atomically serialized admission barrier.
    // Reservations from before revoke are not executable afterwards.
    if(this.unknown||this.revoking||this.revoked||
       !this.active.has(dispatchId)||x.ownerId!==this.owner||
       x.deviceId!==this.device||x.deviceEpoch!==this.deviceEpoch||
       x.sessionEpoch!==this.session||x.ownerEpoch!==this.ownerEpoch||
       x.expectedGeneration!==this.generation)
      throw Error('EXTERNAL_COMMIT_FENCED');
    const now=Date.now();
    const claim=signClaim({kind:'broker_dispatch_commit_v1',
      authorityId:this.authorityId,brokerId:broker.brokerId,dispatchId,
      challengeNonce,requestId:op.requestId,fingerprint:op.fingerprint,
      capability:op.capability,ownerId:x.ownerId,deviceId:x.deviceId,
      deviceEpoch:x.deviceEpoch,sessionEpoch:x.sessionEpoch,
      ownerEpoch:x.ownerEpoch,generation:x.expectedGeneration,
      privilege:x.requiredPrivilege,issuedAtMs:now,expiresAtMs:now+2500});
    if(this.stallCommitResponse){
      this.commitEntered=true;
      await this.holdCommitResponse.promise;
    }
    if(this.loseDispatchCommitAck){
      this.loseDispatchCommitAck=false;
      throw Error('COMMIT_ACK_LOST_AFTER_EFFECT_ADMISSION');
    }
    return claim;
  }
  async release(value:DispatchReleaseRequest){
    const record=this.claimScopes.get(value.dispatchId);
    // Disposable test store only. Real server MUST perform this exact check
    // against its durable immutable claim within the atomic release.
    if(!record||record.brokerId!==value.brokerId||
       JSON.stringify(record.request)!==JSON.stringify(value.request))
      throw Error('RELEASE_SCOPE_MISMATCH');
    this.claimScopes.delete(value.dispatchId);
    this.released.add(value.dispatchId);this.active.delete(value.dispatchId);
    if(this.active.size===0){
      for(const waiter of this.drainWaiters.splice(0))waiter();
    }
    if(this.releaseLost)throw Error('ACK_LOST_AFTER_RELEASE');
  }
  async revokeAndDrain(req:DispatchRevokeRequest):Promise<DispatchClaim>{
    if(this.unknown)throw Error('REVOKE_TIMEOUT');
    if(this.revoked||this.revoking||req.ownerId!==this.owner||
       req.deviceId!==this.device||req.deviceEpoch!==this.deviceEpoch||
       req.sessionEpoch!==this.session||req.expectedGeneration!==this.generation)
      throw Error('REVOKE_STALE');
    this.revoking=true;
    if(this.stallRevoke)await this.holdRevoke.promise;
    if(this.active.size>0)await new Promise<void>(resolve=>
      this.drainWaiters.push(resolve));
    this.revoked=true;this.generation++;
    if(this.loseRevokeAckAfterCommit){
      this.loseRevokeAckAfterCommit=false;
      throw Error('ACK_LOST_AFTER_DURABLE_REVOKE');
    }
    return signClaim({kind:'broker_dispatch_revocation_v1',
      authorityId:this.authorityId,deviceId:this.device,
      ownerId:this.owner,deviceEpoch:this.deviceEpoch,sessionEpoch:this.session,
      previousGeneration:req.expectedGeneration,generation:this.generation,
      drained:true,revoked:true});
  }
}
function fixture(){
 const authorityId=randomUUID(),ownerId=randomUUID(),
  deviceId=randomUUID(),deviceEpoch=randomUUID(),sessionEpoch=randomUUID(),
  brokerId=randomUUID();
 const remote=new FakeRemoteCAS(authorityId,brokerId,{
  owner:ownerId,device:deviceId,epoch:deviceEpoch,session:sessionEpoch,
 });
 let high=true,identity=true,approval=true;
 const request=(id:string=randomUUID()):BrokerDispatchRequest=>({
  requestId:id,fingerprint,capability:'shell.exec',
  scope:{ownerId,deviceId,deviceEpoch,sessionEpoch,
    ownerEpoch:4,expectedGeneration:7,requiredPrivilege:'CORE'},
 });
 const verifyApproval=signedOperatorGrantVerifier(
  ownerKeys.publicKey.export({type:'spki',format:'pem'}).toString());
 const broker=(opts?:{now?:()=>number;onReadback?:()=>void})=>
  new BrokerExternalDispatchFence({
  authority:remote,authorityId,publicKeyPem:keys,
  now:opts?.now,
  verifyIdentity:async()=>identity,
  verifyEffectiveBroker:async()=>{
    opts?.onReadback?.();
    return {
      verified:true,brokerId,highIntegrityToken:high as true,
      ownerEpoch:4,grantGeneration:7,
      signedProtectedImage:true,protectedParentAndImports:true,
    };
  },
  verifyOwnerRevocation:async r=>approval&&verifyApproval({
    kind:'revoke',authorityId,deviceId,ownerId,epoch:deviceEpoch,
    sessionEpoch,generation:r.expectedGeneration,
  },r.signedOwnerApproval),
 });
 const revoke=():DispatchRevokeRequest=>{
  const intent={kind:'revoke',authorityId,deviceId,ownerId,
    epoch:deviceEpoch,sessionEpoch,generation:7};
  const signedOwnerApproval=JSON.stringify(signClaim({
    version:1,intent,nonce:randomUUID(),issuedAt:Date.now()-1000,
    expiresAt:Date.now()+60000,
  },ownerKeys.privateKey));
  return {deviceId,ownerId,deviceEpoch,sessionEpoch,
    expectedGeneration:7,signedOwnerApproval};
 };
 return {broker,request,revoke,remote,deviceId,
  setHigh:(v:boolean)=>{high=v},
  setIdentity:(v:boolean)=>{identity=v},
  setApproval:(v:boolean)=>{approval=v},
 };
}
const code=async(p:Promise<unknown>,expected:string)=>
 assert.rejects(p,{code:expected});

test('external release refuses wrong owner, session, grant generation and broker',async()=>{
 const f=fixture(),op=f.request();
 const broker:ProtectedBrokerEvidence={
  verified:true,brokerId:f.remote.brokerId,ownerEpoch:4,grantGeneration:7,
  highIntegrityToken:true,signedProtectedImage:true,
  protectedParentAndImports:true,
 };
 const claimed=await f.remote.beginIfCurrent(op,broker,'1'.repeat(64));
 const decoded=JSON.parse(Buffer.from(claimed.payload,'base64url').toString('utf8')) as {dispatchId:string};
 const id=decoded.dispatchId;
 const different=(scope:Partial<BrokerDispatchRequest['scope']>)=>({
  dispatchId:id,brokerId:broker.brokerId,
  request:{...op,scope:{...op.scope,...scope}},
 });
 for(const invalid of [
  different({ownerId:randomUUID()}),
  different({deviceId:randomUUID()}),
  different({deviceEpoch:randomUUID()}),
  different({sessionEpoch:randomUUID()}),
  different({expectedGeneration:8}),
  different({ownerEpoch:5}),
  {...different({}),brokerId:randomUUID()},
  {...different({}),request:{...op,fingerprint:'b'.repeat(64)}},
 ]){
  await assert.rejects(f.remote.release(invalid),/RELEASE_SCOPE_MISMATCH/);
  assert.equal(f.remote.active.has(id),true,'wrong owner must not drain claim');
 }
 await f.remote.release({dispatchId:id,brokerId:broker.brokerId,request:op});
 assert.equal(f.remote.active.size,0);
 await assert.rejects(f.remote.release({
   dispatchId:id,brokerId:broker.brokerId,request:op,
 }),/RELEASE_SCOPE_MISMATCH/);
});

test('verified high-token Broker executes once after new signed external CAS permit',async()=>{
 const f=fixture(),gate=f.broker();
 let effects=0;
 assert.equal(await gate.execute(f.request(),async()=>++effects),1);
 assert.equal(effects,1);
 assert.equal(f.remote.active.size,0);
 assert.equal(f.remote.released.size,1);
 await code(gate.execute(f.request([...f.remote.dispatched.keys()][0]!),async()=>++effects),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 assert.equal(effects,1);
});
test('begin permit expiry during async HIGH reattestation blocks remote commit',async()=>{
 const f=fixture();
 let readbacks=0,clock=Date.now(),effects=0;
 const gate=f.broker({now:()=>clock,
  onReadback:()=>{if(++readbacks===2)clock+=10_000}});
 await code(gate.execute(f.request(),async()=>++effects),
  'DISPATCH_PROOF_EXPIRED');
 assert.equal(readbacks,2);
 assert.equal(f.remote.commitCalls,0,'expired reserve must never commit');
 assert.equal(f.remote.active.size,0,'reserved claim is released');
 assert.equal(effects,0);
 await code(gate.execute(f.request(),async()=>++effects),
  'DISPATCH_REVOKE_PENDING');
 assert.equal(effects,0,'expiry must not replay the mutation');
});
test('commit expires during final async HIGH readback, callback is not invoked',async()=>{
 const f=fixture();
 let readbacks=0,clock=Date.now(),effects=0;
 const gate=f.broker({now:()=>clock,
  onReadback:()=>{if(++readbacks===3)clock+=10_000}});
 await code(gate.execute(f.request(),async()=>++effects),
  'DISPATCH_PROOF_EXPIRED');
 assert.equal(readbacks,3,'native evidence must be refreshed after commit');
 assert.equal(f.remote.commitCalls,1,'admission completed before expiry');
 assert.equal(f.remote.active.size,0,'committed claim is released');
 assert.equal(effects,0,'expired signed receipt may not reach OS');
 await code(gate.execute(f.request(),async()=>++effects),
  'DISPATCH_REVOKE_PENDING');
 assert.equal(effects,0);
});
test('lost begin ACK after durable reservation cannot mint a second permit across Hubs',async()=>{
 const f=fixture(),op=f.request(),hubA=f.broker(),hubB=f.broker();
 let effects=0;
 f.remote.loseBeginAckAfterReservation=true;
 await code(hubA.execute(op,async()=>++effects),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 assert.equal(f.remote.dispatched.size,1,
  'request UUID must be tombstoned before reservation ACK');
 assert.equal(f.remote.active.size,1,
  'lost ACK remains reserved/UNKNOWN until explicit reconciliation');
 assert.equal(effects,0,'lost begin ACK never reaches the OS callback');
 await code(hubB.execute(op,async()=>++effects),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 assert.equal(f.remote.beginChallenges.length,2,
  'a second Hub attempts a fresh begin with a fresh challenge');
 assert.notEqual(f.remote.beginChallenges[0],f.remote.beginChallenges[1]);
 assert.equal(f.remote.dispatched.size,1,
  'same requestId cannot allocate a new dispatchId after lost ACK');
 assert.equal(f.remote.active.size,1,
  'retry must not replace or erase the original reservation');
 assert.equal(effects,0,'UNKNOWN is never replayed');
});
test('HIGH token downgraded during begin CAS wait is rechecked before commit',async()=>{
 const f=fixture(),gate=f.broker();f.remote.stallBeginResponse=true;
 let effects=0;
 const pending=gate.execute(f.request(),async()=>{effects++;return true});
 for(let i=0;i<300&&f.remote.active.size===0;i++)await Promise.resolve();
 assert.equal(f.remote.active.size,1,'external reservation is pending');
 f.setHigh(false);
 f.remote.holdBeginResponse.resolve();
 await code(pending,'DISPATCH_HIGH_TOKEN_UNVERIFIED');
 assert.equal(effects,0);
 assert.equal(f.remote.active.size,0,'reserved claim released after stale evidence');
});
test('HIGH token downgraded during commit CAS wait is rechecked before effect',async()=>{
 const f=fixture(),gate=f.broker();f.remote.stallCommitResponse=true;
 let effects=0;
 const pending=gate.execute(f.request(),async()=>{effects++;return true});
 for(let i=0;i<300&&!f.remote.commitEntered;i++)await Promise.resolve();
 assert.equal(f.remote.commitEntered,true,'external commit response is pending');
 f.setHigh(false);
 f.remote.holdCommitResponse.resolve();
 await code(pending,'DISPATCH_HIGH_TOKEN_UNVERIFIED');
 assert.equal(effects,0,'no effect may use pre-await HIGH evidence');
 assert.equal(f.remote.active.size,0,'committed claim released after stale evidence');
});

test('unsigned/forged permit and restored stale local grant cannot execute',async()=>{
 const f=fixture(),gate=f.broker();f.remote.forged=true;
 let effects=0;
 await code(gate.execute(f.request(),async()=>++effects),
  'DISPATCH_SIGNATURE_UNTRUSTED');
 assert.equal(effects,0);
});
test('wrong owner/session/epoch and missing elevated broker proof fail closed',async()=>{
 const f=fixture(),gate=f.broker();let effects=0;
 f.setHigh(false);
 await code(gate.execute(f.request(),async()=>++effects),
  'DISPATCH_HIGH_TOKEN_UNVERIFIED');
 f.setHigh(true);f.setIdentity(false);
 await code(gate.execute(f.request(),async()=>++effects),
  'DISPATCH_IDENTITY_UNVERIFIED');
 f.setIdentity(true);f.remote.deviceEpoch=randomUUID();
 await code(gate.execute(f.request(),async()=>++effects),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 assert.equal(effects,0);
});
test('concurrent duplicate reservation: only one dispatch, no replay',async()=>{
 const f=fixture(),gate=f.broker(),op=f.request();
 let executed=0;
 const attempts=await Promise.allSettled(Array.from({length:28},()=>
  gate.execute(op,async()=>{executed++;return true})));
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(executed,1);
});
test('two independent Hubs share remote CAS: duplicate UUID permits one effect',async()=>{
 const f=fixture(),hubA=f.broker(),hubB=f.broker();
 const same=f.request();let effects=0;
 const [a,b]=await Promise.allSettled([
   hubA.execute(same,async()=>{effects++;return 'A'}),
   hubB.execute(same,async()=>{effects++;return 'B'}),
 ]);
 assert.equal([a,b].filter(x=>x.status==='fulfilled').length,1);
 assert.equal([a,b].filter(x=>x.status==='rejected').length,1);
 assert.equal(effects,1);
 assert.equal(f.remote.dispatched.size,1);
 assert.equal(f.remote.active.size,0);
});
test('Hub B cannot reuse Hub A signed permit even if remote replays it',async()=>{
 const f=fixture(),hubA=f.broker(),hubB=f.broker();
 let effects=0;
 assert.equal(await hubA.execute(f.request(),async()=>++effects),1);
 f.remote.claimReplay=true; // malicious cache supplies valid old signature
 await code(hubB.execute(f.request(),async()=>++effects),
   'DISPATCH_PROOF_SCOPE_MISMATCH');
 assert.equal(effects,1);
});
test('Hub B revoke loses ACK after durable commit; both Hubs deny further dispatch',async()=>{
 const f=fixture(),hubA=f.broker(),hubB=f.broker(),effect=deferred();
 let effects=0;
 const admitted=hubA.execute(f.request(),async()=>{effects++;await effect.promise});
 for(let i=0;i<400&&effects!==1;i++)await Promise.resolve();
 assert.equal(effects,1);
 f.remote.loseRevokeAckAfterCommit=true;
 const revoking=hubB.revoke(f.revoke());
 await code(hubB.execute(f.request(),async()=>{effects++}),
   'DISPATCH_REVOKE_PENDING');
 effect.resolve();
 await admitted;
 await code(revoking,'DISPATCH_REVOKE_OUTCOME_UNKNOWN');
 assert.equal(f.remote.revoked,true);
 assert.equal(f.remote.generation,8);
 await code(hubA.execute(f.request(),async()=>{effects++}),
   'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 await code(hubB.execute(f.request(),async()=>{effects++}),
   'DISPATCH_REVOKE_PENDING');
 assert.equal(effects,1);
});
test('Hub A release ACK lost while Hub B drains revoke; no duplicate effect',async()=>{
 const f=fixture(),hubA=f.broker(),hubB=f.broker(),effect=deferred();
 f.remote.releaseLost=true;
 let effects=0;
 const admitted=hubA.execute(f.request(),async()=>{effects++;await effect.promise});
 for(let i=0;i<400&&effects!==1;i++)await Promise.resolve();
 assert.equal(effects,1);
 const revoking=hubB.revoke(f.revoke());
 effect.resolve();
 await admitted; // underlying release removed remote active claim but ACK was lost
 assert.equal((await revoking).drained,true);
 assert.equal(f.remote.active.size,0);
 await code(hubA.execute(f.request(),async()=>{effects++}),
   'DISPATCH_REVOKE_PENDING');
 await code(hubB.execute(f.request(),async()=>{effects++}),
   'DISPATCH_REVOKE_PENDING');
 assert.equal(effects,1);
});

test('two-Hub late pre-revoke signed permit cannot launch effect during remote drain',async()=>{
 const f=fixture(),hubA=f.broker(),hubB=f.broker();
 f.remote.stallBeginResponse=true;
 let effects=0;
 const op=f.request();
 const pending=hubA.execute(op,async()=>{effects++;return 'SHOULD_NOT_RUN'});
 for(let i=0;i<400&&f.remote.active.size!==1;i++)await Promise.resolve();
 assert.equal(f.remote.active.size,1,'reservation exists before revoke');
 const revoking=hubB.revoke(f.revoke()); // Other Hub cannot set Hub A local flag
 for(let i=0;i<400&&!f.remote.revoking;i++)await Promise.resolve();
 assert.equal(f.remote.revoking,true);
 assert.equal(effects,0);
 f.remote.holdBeginResponse.resolve(); // VALID signed permit delivered late
 await code(pending,'DISPATCH_COMMIT_UNKNOWN');
 assert.equal((await revoking).drained,true);
 assert.equal(f.remote.active.size,0);
 assert.equal(effects,0,'remote commit barrier prevented late side effect');
});
test('commit ACK lost after remote admission is UNKNOWN, never callback replay',async()=>{
 const f=fixture(),hub=f.broker();
 f.remote.loseDispatchCommitAck=true;
 let effects=0;
 await code(hub.execute(f.request(),async()=>{effects++}),
   'DISPATCH_COMMIT_UNKNOWN');
 assert.equal(effects,0);
 assert.equal(f.remote.active.size,0);
 await code(hub.execute(f.request(),async()=>{effects++}),
   'DISPATCH_REVOKE_PENDING');
 assert.equal(effects,0);
});

test('revoke drains admitted effect and blocks concurrent new dispatch',async()=>{
 const f=fixture(),gate=f.broker(),effect=deferred();
 let executed=0;
 const first=gate.execute(f.request(),async()=>{executed++;await effect.promise});
 // Wait until effect has started deterministically.
 while(executed!==1)await Promise.resolve();
 const result=gate.revoke(f.revoke());
 await code(gate.execute(f.request(),async()=>{executed++}),
  'DISPATCH_REVOKE_PENDING');
 assert.equal(f.remote.revoked,false);
 effect.resolve();
 await first;
 const receipt=await result;
 assert.equal(receipt.drained,true);
 assert.equal(f.remote.revoked,true);
 assert.equal(executed,1);
});
test('stalled revoke is locally fenced and cannot be bypassed by signed old grant',async()=>{
 const f=fixture(),gate=f.broker();
 f.remote.stallRevoke=true;
 const pending=gate.revoke(f.revoke());
 await code(gate.execute(f.request(),async()=>{throw Error('MUST_NOT_RUN')}),
  'DISPATCH_REVOKE_PENDING');
 f.remote.holdRevoke.resolve();
 assert.equal((await pending).revoked,true);
});
test('unknown revoke and lost-release ACK remain locally fail closed',async()=>{
 const f=fixture(),gate=f.broker();f.remote.releaseLost=true;
 await gate.execute(f.request(),async()=>true);
 await code(gate.execute(f.request(),async()=>true),
  'DISPATCH_REVOKE_PENDING');
 const second=fixture(),other=second.broker();
 second.remote.unknown=true;
 await code(other.revoke(second.revoke()),'DISPATCH_REVOKE_OUTCOME_UNKNOWN');
 await code(other.execute(second.request(),async()=>true),
  'DISPATCH_REVOKE_PENDING');
});
test('invalid owner signature blocks revoke and keeps local fence closed',async()=>{
 const f=fixture(),gate=f.broker();f.setApproval(false);
 await code(gate.revoke(f.revoke()),'DISPATCH_REVOKE_SIGNATURE_UNTRUSTED');
 await code(gate.execute(f.request(),async()=>true),'DISPATCH_REVOKE_PENDING');
});
test('forged Ed25519 owner revoke approval is rejected before remote CAS',async()=>{
 const f=fixture(),gate=f.broker(),revoke=f.revoke();
 const forged=JSON.parse(revoke.signedOwnerApproval) as
   {payload:string;signature:string};
 forged.signature=sign(null,Buffer.from(forged.payload,'base64url'),
  generateKeyPairSync('ed25519').privateKey).toString('base64url');
 await code(gate.revoke({...revoke,signedOwnerApproval:JSON.stringify(forged)}),
  'DISPATCH_REVOKE_SIGNATURE_UNTRUSTED');
 assert.equal(f.remote.revoked,false);
 await code(gate.execute(f.request(),async()=>true),'DISPATCH_REVOKE_PENDING');
});

test('reserved claim awaiting delivery drains safely during stalled revoke',async()=>{
 const f=fixture(),gate=f.broker();f.remote.stallBeginResponse=true;
 let effects=0;
 const pending=gate.execute(f.request(),async()=>{effects++;return 1});
 for(let i=0;i<300&&f.remote.active.size!==1;i++)await Promise.resolve();
 assert.equal(f.remote.active.size,1,'externally reserved claim exists');
 f.remote.stallRevoke=true;
 const revoking=gate.revoke(f.revoke());
 await code(gate.execute(f.request(),async()=>{effects++}),
  'DISPATCH_REVOKE_PENDING');
 assert.equal(f.remote.revoked,false);
 f.remote.holdRevoke.resolve();
 f.remote.holdBeginResponse.resolve();
 await code(pending,'DISPATCH_REVOKE_PENDING');
 const receipt=await revoking;
 assert.equal(receipt.drained,true);
 assert.equal(f.remote.active.size,0,'claim was released before remote drain');
 assert.equal(effects,0,'no side effect started after pending revoke');
});
test('wrong current owner epoch and validly signed stale owner epoch refuse dispatch',async()=>{
 const f=fixture(),gate=f.broker();
 let executions=0;
 const wrong=f.request();wrong.scope.ownerEpoch=3;
 await code(gate.execute(wrong,async()=>++executions),
  'DISPATCH_OWNER_EPOCH_MISMATCH');
 f.remote.ownerEpoch=5;
 await code(gate.execute(f.request(),async()=>++executions),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
 assert.equal(executions,0);
 const other=fixture(),otherGate=other.broker();
 other.remote.wrongSignedOwnerEpoch=true;
 await code(otherGate.execute(other.request(),async()=>++executions),
  'DISPATCH_PROOF_SCOPE_MISMATCH');
 assert.equal(executions,0);
});
test('signed claim copied through real SQLite WAL restore cannot replay after restart',async t=>{
 const dir=await mkdtemp(path.join(process.cwd(),'test','nx-587-claim-replay-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'signed.sqlite'),snapshot=path.join(dir,'old.sqlite');
 const db=new DatabaseSync(file);
 db.exec('PRAGMA journal_mode=WAL; CREATE TABLE claims(proof TEXT, grant_epoch INTEGER)');
 const f=fixture(),request=f.request();
 let executed=0;
 assert.equal(await f.broker().execute(request,async()=>++executed),1);
 const firstClaim=f.remote.lastClaim;
 assert.ok(firstClaim);
 db.prepare('INSERT INTO claims VALUES (?,?)').run(JSON.stringify(firstClaim),4);
 await backup(db,snapshot);
 db.exec('UPDATE claims SET grant_epoch=0; PRAGMA wal_checkpoint(TRUNCATE)');
 db.close();
 await copyFile(snapshot,file);
 const restored=new DatabaseSync(file,{readOnly:true});
 const row=restored.prepare('SELECT proof,grant_epoch FROM claims').get() as
   {proof:string;grant_epoch:number};
 assert.equal(row.grant_epoch,4);
 assert.deepEqual(JSON.parse(row.proof),firstClaim);
 restored.close();
 // Adversarial remote/proxy violates its required single-use CAS guarantee:
 // it replays exactly the old VALID Ed25519 signature from restored WAL.
 f.remote.claimReplay=true;
 await code(f.broker().execute(request,async()=>++executed),
  'DISPATCH_PROOF_SCOPE_MISMATCH');
 assert.equal(executed,1,'new Broker instance did not execute old claim');
});

test('restored isolated SQLite/WAL cannot authorize dispatch after external revoke',async t=>{
 const dir=await mkdtemp(path.join(process.cwd(),'test','nx-587-dispatch-wal-'));
 t.after(()=>rm(dir,{force:true,recursive:true}));
 const file=path.join(dir,'agent.sqlite'),snapshot=path.join(dir,'old.sqlite');
 const db=new DatabaseSync(file);
 db.exec('PRAGMA journal_mode=WAL; CREATE TABLE grants(owner TEXT,active INTEGER);');
 db.prepare('INSERT INTO grants VALUES(?,?)').run('owner',1);
 await backup(db,snapshot);
 const f=fixture(),gate=f.broker();
 // External revoke commits, independent of SQLite snapshot ownership.
 await gate.revoke(f.revoke());
 db.exec('UPDATE grants SET active=0; PRAGMA wal_checkpoint(TRUNCATE);');
 db.close();
 await copyFile(snapshot,file);
 const restored=new DatabaseSync(file,{readOnly:true});
 assert.equal((restored.prepare('SELECT active FROM grants').get() as
   {active:number}).active,1);
 restored.close();
 await code(gate.execute(f.request(),async()=>{throw Error('MUST_NOT_RUN')}),
  'DISPATCH_REVOKE_PENDING');
 // New Broker process also depends on external authority, not SQLite WAL.
 await code(f.broker().execute(f.request(),async()=>true),
  'DISPATCH_EXTERNAL_CAS_UNKNOWN');
});
