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
  type ProtectedBrokerEvidence,type DispatchRevokeRequest}
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
  readonly released=new Set<string>();
  generation=7;
  owner:string;
  device:string;
  deviceEpoch:string;
  session:string;
  revoked=false;revoking=false;unknown=false;forged=false;
  staleSignature=false;claimReplay=false;releaseLost=false;
  private lastClaim:DispatchClaim|undefined;
  private readonly drainWaiters:Array<()=>void>=[];
  readonly holdRevoke=deferred();
  stallRevoke=false;
  number=0;
  constructor(readonly authorityId:string,
    readonly brokerId:string,
    identity:{owner:string;device:string;epoch:string;session:string}){
    this.owner=identity.owner;this.device=identity.device;
    this.deviceEpoch=identity.epoch;this.session=identity.session;
  }
  async beginIfCurrent(op:BrokerDispatchRequest,
    broker:ProtectedBrokerEvidence):Promise<DispatchClaim>{
    if(this.unknown)throw Error('EXTERNAL_TIMEOUT');
    const x=op.scope;
    if(this.revoked||this.revoking||x.ownerId!==this.owner||
       x.deviceId!==this.device||x.deviceEpoch!==this.deviceEpoch||
       x.sessionEpoch!==this.session||x.expectedGeneration!==this.generation)
      throw Error('EXTERNAL_FENCE_DENIED');
    if(this.dispatched.has(op.requestId))throw Error('DISPATCH_REPLAY');
    const dispatchId=randomUUID();
    this.dispatched.set(op.requestId,dispatchId);this.active.add(dispatchId);
    const now=Date.now();
    const permit=signClaim({kind:'broker_dispatch_permit_v1',
      authorityId:this.authorityId,
      brokerId:broker.brokerId,dispatchId,
      requestId:op.requestId,fingerprint:op.fingerprint,
      capability:op.capability,
      ownerId:x.ownerId,deviceId:x.deviceId,deviceEpoch:x.deviceEpoch,
      sessionEpoch:x.sessionEpoch,generation:x.expectedGeneration,
      privilege:x.requiredPrivilege,issuedAtMs:now,
      expiresAtMs:now+2500},this.forged
      ?generateKeyPairSync('ed25519').privateKey:authorityKeys.privateKey);
    if(this.claimReplay&&this.lastClaim)return this.lastClaim;
    this.lastClaim=permit;
    return permit;
  }
  async release(claimId:string){
    this.released.add(claimId);this.active.delete(claimId);
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
    expectedGeneration:7,requiredPrivilege:'CORE'},
 });
 const verifyApproval=signedOperatorGrantVerifier(
  ownerKeys.publicKey.export({type:'spki',format:'pem'}).toString());
 const broker=()=>new BrokerExternalDispatchFence({
  authority:remote,authorityId,publicKeyPem:keys,
  verifyIdentity:async()=>identity,
  verifyEffectiveBroker:async()=>({
    verified:true,brokerId,highIntegrityToken:high as true,
    signedProtectedImage:true,protectedParentAndImports:true,
  }),
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
