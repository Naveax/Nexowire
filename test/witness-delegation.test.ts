import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {PostgresWitnessDelegation,type DelegationChange}
 from '../src/agent/witness-delegation.js';
import {signedOperatorGrantVerifier} from '../src/agent/witness-signed-provenance.js';
import type {WitnessPgPool,WitnessPgConnection,WitnessOperatorIntent}
 from '../src/agent/postgres-monotonic-witness.js';

type Device={owner_id:string;epoch:string;generation:number;state:string};
type Row={owner_id:string;epoch:string;session_epoch:string;generation:number;
 core_enabled:boolean;root_expires_ms:number|null;max_seen_ms:number};
type Store={devices:Map<string,Device>;delegations:Map<string,Row>};
const clone=(s:Store):Store=>({
 devices:new Map([...s.devices].map(([k,v])=>[k,{...v}])),
 delegations:new Map([...s.delegations].map(([k,v])=>[k,{...v}])),
});
class PgContractPool implements WitnessPgPool{
 state:Store={devices:new Map(),delegations:new Map()};
 now=Date.now();
 available=true;
 commitAckLost=false;
 failNextDelegationUpdate=false;
 private pending=Promise.resolve();
 async connect():Promise<WitnessPgConnection>{
  if(!this.available)throw Error('POSTGRES_UNAVAILABLE');
  let done=()=>{};
  const release=new Promise<void>(res=>{done=res});
  const prior=this.pending;this.pending=release;await prior;
  let transaction:Store|undefined;
  const state=()=>transaction??this.state;
  return {release:done,query:async(sql,values=[])=>{
   if(!this.available)throw Error('POSTGRES_DISCONNECTED');
   if(sql==='BEGIN'){transaction=clone(this.state);return {rows:[]}}
   if(sql==='COMMIT'){
    if(transaction)this.state=transaction;
    transaction=undefined;
    if(this.commitAckLost){
     this.commitAckLost=false;throw Error('COMMIT_ACK_LOST');
    }
    return {rows:[]};
   }
   if(sql==='ROLLBACK'){transaction=undefined;return {rows:[]}}
   if(sql.startsWith('SELECT FLOOR(EXTRACT(EPOCH')){
    return {rows:[{now_ms:String(this.now)}]};
   }
   const s=state();
   if(sql.startsWith('SELECT owner_id,epoch,generation,state')){
    const value=s.devices.get(String(values[0]));
    return {rows:value?[{...value}]:[]};
   }
   if(sql.startsWith('SELECT owner_id,epoch,session_epoch,generation,')){
    const value=s.delegations.get(String(values[0]));
    return {rows:value?[{...value}]:[]};
   }
   if(sql.startsWith('INSERT INTO witness_delegations')){
    const [device,owner,epoch,session,,time]=values;
    // Query binds five placeholders, with 1 literal generation.
    if(s.delegations.has(String(device)))throw Error('UNIQUE_VIOLATION');
    s.delegations.set(String(device),{
      owner_id:String(owner),epoch:String(epoch),session_epoch:String(session),
      generation:1,core_enabled:false,root_expires_ms:null,
      max_seen_ms:Number(values[4]),
    });
    return {rows:[]};
   }
   if(sql.startsWith('UPDATE witness_delegations SET max_seen_ms')){
    const row=s.delegations.get(String(values[0]));
    if(!row)return {rows:[]};
    row.max_seen_ms=Number(values[1]);
    return {rows:[]};
   }
   if(sql.startsWith('UPDATE witness_devices SET owner_id')){
    const [device,newOwner,newEpoch,expectedOwner,expectedEpoch,gen]=values;
    const row=s.devices.get(String(device));
    if(!row||row.owner_id!==expectedOwner||row.epoch!==expectedEpoch||
       row.generation!==gen||row.state!=='active')return {rows:[]};
    row.owner_id=String(newOwner);row.epoch=String(newEpoch);row.generation++;
    return {rows:[{generation:row.generation}]};
   }
   if(sql.startsWith('UPDATE witness_delegations SET owner_id')){
    if(this.failNextDelegationUpdate){
      this.failNextDelegationUpdate=false;
      throw Error('DISK_FULL_UNCOMMITTED');
    }
    const [device,owner,epoch,session,gen,core,root,now,expected]=values;
    const row=s.delegations.get(String(device));
    if(!row||row.generation!==expected)return {rows:[]};
    Object.assign(row,{owner_id:owner,epoch,session_epoch:session,
      generation:gen,core_enabled:core,root_expires_ms:root,max_seen_ms:now});
    return {rows:[{generation:row.generation}]};
   }
   throw Error('Unexpected PostgreSQL query contract: '+sql);
  }};
 }
}
function fixture(){
 const db=new PgContractPool(),deviceId=randomUUID(),ownerId=randomUUID(),
  deviceEpoch=randomUUID(),sessionEpoch=randomUUID(),
  newOwnerId=randomUUID(),newDeviceEpoch=randomUUID();
 db.state.devices.set(deviceId,{owner_id:ownerId,epoch:deviceEpoch,
  generation:1,state:'active'});
 const keys=generateKeyPairSync('ed25519');
 const trusted=keys.publicKey.export({format:'pem',type:'spki'}).toString();
 const verify=signedOperatorGrantVerifier(trusted);
 const signChange=(c:Omit<DelegationChange,'signedProof'>):DelegationChange=>{
  const i:WitnessOperatorIntent={
    kind:c.action,authorityId,deviceId:c.deviceId,ownerId:c.ownerId,
    epoch:c.deviceEpoch,sessionEpoch:c.sessionEpoch,
    generation:c.expectedGeneration,nextSessionEpoch:c.newSessionEpoch,
    nextOwnerId:c.newOwnerId,nextEpoch:c.newDeviceEpoch,
  };
  const now=Date.now();
  const bytes=Buffer.from(JSON.stringify({
    version:1,intent:i,nonce:randomUUID(),
    issuedAt:now-1000,expiresAt:now+60000,
  }));
  const signedProof=JSON.stringify({
    payload:bytes.toString('base64url'),
    signature:sign(null,bytes,keys.privateKey).toString('base64url'),
  });
  return {...c,signedProof};
 };
 const authorityId=randomUUID();
 const allowedSessions=new Set<string>([sessionEpoch]);
 let provenance=true;
 const make=()=>new PostgresWitnessDelegation({
  pool:db,authorityId,
  resolvePrincipal:async(dev,epoch)=>{
   const row=db.state.devices.get(dev);
   return row&&row.epoch===epoch?{deviceId:dev,epoch,ownerId:row.owner_id}:undefined;
  },
  verifySession:async(i)=>allowedSessions.has(i.sessionEpoch),
  verifyOperatorApproval:verify,
  verifyProvenance:async()=>({
   verified:provenance,authorityId,validUntil:Date.now()+60000,
  }),
 });
 const change=(action:DelegationChange['action'],generation:number,
  extra:Partial<Omit<DelegationChange,'action'|'expectedGeneration'|'signedProof'>>={},
  owner=ownerId,epoch=deviceEpoch,session=sessionEpoch)=>
   signChange({action,deviceId,ownerId:owner,deviceEpoch:epoch,sessionEpoch:session,
    expectedGeneration:generation,...extra});
 const identity=(owner=ownerId,epoch=deviceEpoch,session=sessionEpoch)=>
  ({ownerId:owner,deviceId,deviceEpoch:epoch,sessionEpoch:session});
 return {db,deviceId,ownerId,deviceEpoch,sessionEpoch,newOwnerId,
  newDeviceEpoch,allowedSessions,change,identity,make,
  disableProvenance:()=>{provenance=false},
 };
}
const code=(value:Promise<unknown>,expected:string)=>
 assert.rejects(value,{code:expected});
test('no implicit delegation; signed CORE survives restart but not wrong session',async()=>{
 const f=fixture(),gate=f.make();
 await code(gate.evaluate(f.identity()),'DELEGATION_SESSION_FENCED');
 await code(gate.change({...f.change('bind_session',0),signedProof:'bad'}),
  'DELEGATION_OWNER_APPROVAL_REQUIRED');
 assert.equal((await gate.change(f.change('bind_session',0))).generation,1);
 assert.equal((await gate.change(f.change('grant_core',1))).mode,'CORE');
 assert.equal((await f.make().evaluate(f.identity())).mode,'CORE');
 const rotated=randomUUID();f.allowedSessions.add(rotated);
 await gate.change(f.change('rotate_session',2,{newSessionEpoch:rotated}));
 await code(gate.evaluate(f.identity()),'DELEGATION_SESSION_FENCED');
 const effective=await f.make().evaluate(f.identity(f.ownerId,f.deviceEpoch,rotated));
 assert.equal(effective.mode,'CORE');assert.equal(effective.corePersisted,true);
});
test('ROOT is exactly 15m on DB clock, falls back to CORE when expired',async()=>{
 const f=fixture(),g=f.make();
 await g.change(f.change('bind_session',0));
 await g.change(f.change('grant_core',1));
 const root=await g.change(f.change('grant_root',2));
 assert.equal(root.mode,'ROOT');
 assert.equal(root.rootExpiresAtMs,f.db.now+900000);
 f.db.now+=899999;
 assert.equal((await g.evaluate(f.identity())).mode,'ROOT');
 f.db.now+=1;
 assert.equal((await g.evaluate(f.identity())).mode,'CORE');
});
test('ROOT only expires to NONE; backwards server time fails closed',async()=>{
 const f=fixture(),g=f.make();
 await g.change(f.change('bind_session',0));
 const root=await g.change(f.change('grant_root',1));
 assert.equal(root.corePersisted,false);
 f.db.now+=900000;
 assert.equal((await g.evaluate(f.identity())).mode,'NONE');
 f.db.now-=1;
 await code(g.evaluate(f.identity()),'DELEGATION_SERVER_CLOCK_ROLLBACK');
});
test('revoke denies CORE and ROOT; stale signed grant cannot resurrect permissions',async()=>{
 const f=fixture(),g=f.make();
 await g.change(f.change('bind_session',0));
 const signedOld=f.change('grant_core',1);
 await g.change(signedOld);
 await g.change(f.change('grant_root',2));
 assert.equal((await g.evaluate(f.identity())).mode,'ROOT');
 const revoked=await g.change(f.change('revoke',3));
 assert.equal(revoked.mode,'NONE');
 await code(g.change(signedOld),'DELEGATION_STALE_GENERATION');
 assert.equal((await g.evaluate(f.identity())).mode,'NONE');
});
test('re-pair atomically fences previous owner, session, CORE and ROOT',async()=>{
 const f=fixture(),g=f.make(),newSession=randomUUID();
 await g.change(f.change('bind_session',0));
 await g.change(f.change('grant_core',1));
 await g.change(f.change('grant_root',2));
 const fresh=await g.change(f.change('re_pair',3,{
  newOwnerId:f.newOwnerId,newDeviceEpoch:f.newDeviceEpoch,
  newSessionEpoch:newSession,
 }));
 assert.equal(fresh.mode,'NONE');
 await code(g.evaluate(f.identity()),'DELEGATION_IDENTITY_UNVERIFIED');
 f.allowedSessions.add(newSession);
 const authorized=await f.make().evaluate(f.identity(
  f.newOwnerId,f.newDeviceEpoch,newSession));
 assert.equal(authorized.mode,'NONE');
 assert.equal(authorized.corePersisted,false);
});
test('stale epoch/session/wrong device token and replayed generation are denied',async()=>{
 const f=fixture(),g=f.make();
 const initial=f.change('bind_session',0);
 await g.change(initial);
 await code(g.change(initial),'DELEGATION_ALREADY_BOUND');
 const other=f.change('grant_core',1,{sessionEpoch:randomUUID()});
 await code(g.change(other),'DELEGATION_IDENTITY_UNVERIFIED');
 const session=f.change('grant_core',1);
 const outcomes=await Promise.allSettled([g.change(session),g.change(session)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
 f.disableProvenance();
 await code(g.evaluate(f.identity()),'DELEGATION_PROVENANCE_UNVERIFIED');
});
test('disk-full during owner delegation transition rolls back all permissions',async()=>{
 const f=fixture(),g=f.make();
 await g.change(f.change('bind_session',0));
 f.db.failNextDelegationUpdate=true;
 await assert.rejects(g.change(f.change('grant_core',1)),/DISK_FULL_UNCOMMITTED/);
 assert.equal((await g.evaluate(f.identity())).mode,'NONE');
 assert.equal((await g.evaluate(f.identity())).generation,1);
});
test('re-pair cannot reuse the original session or epoch',async()=>{
 const f=fixture(),g=f.make();
 await g.change(f.change('bind_session',0));
 await code(g.change(f.change('re_pair',1,{
  newOwnerId:f.newOwnerId,newDeviceEpoch:f.newDeviceEpoch,
  newSessionEpoch:f.sessionEpoch,
 })),'DELEGATION_SESSION_ROTATION_INVALID');
 assert.equal((await g.evaluate(f.identity())).mode,'NONE');
});
test('lost COMMIT ACK and rollback of witness itself are not accepted as physical proof',async()=>{
 const f=fixture(),g=f.make();
 await g.change(f.change('bind_session',0));
 f.db.commitAckLost=true;
 await assert.rejects(g.change(f.change('grant_core',1)),/COMMIT_ACK_LOST/);
 assert.equal((await g.evaluate(f.identity())).mode,'CORE');
 // Reverting the witness to an earlier snapshot can eliminate later grants.
 // This deliberately demonstrates the physical release blocker.
 const prior=f.db.state.delegations.get(f.deviceId)!;
 const copy={...prior,core_enabled:false,generation:1};
 f.db.state.delegations.set(f.deviceId,copy);
 assert.equal((await g.evaluate(f.identity())).mode,'NONE');
});
