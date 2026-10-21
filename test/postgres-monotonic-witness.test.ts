import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresMonotonicWitness,type WitnessPgPool,
 type WitnessPgConnection,type WitnessOperatorIntent}
 from '../src/agent/postgres-monotonic-witness.js';

const fp='f'.repeat(64);
type Device={owner_id:string;epoch:string;generation:number;state:string};
type Row={sequence:number;device_id:string;owner_id:string;
 epoch:string;fingerprint:string;capability:string};
type Store={devices:Map<string,Device>;reservations:Map<string,Row>;sequence:number};
function clone(s:Store):Store{return {
 devices:new Map([...s.devices].map(([k,v])=>[k,{...v}])),
 reservations:new Map([...s.reservations].map(([k,v])=>[k,{...v}])),
 sequence:s.sequence,
}}
/**
 * Disposable SQL contract simulator; NOT real PostgreSQL and not a durable
 * monotonic authority. It checks query/transaction/rollback state machines.
 */
class DeterministicPgPool implements WitnessPgPool {
 store:Store={devices:new Map(),reservations:new Map(),sequence:0};
 available=true;
 loseNextCommitAcknowledgement=false;
 private previous:Promise<void>=Promise.resolve();
 async connect():Promise<WitnessPgConnection>{
  if(!this.available)throw Error('STORAGE_UNAVAILABLE');
  let unlock=()=>{};
  const release=new Promise<void>(resolve=>{unlock=resolve});
  const prior=this.previous;
  this.previous=release;
  await prior;
  let staged:Store|undefined;
  const view=()=>staged??this.store;
  return {release:unlock,query:async(sql,values=[])=>{
   if(!this.available)throw Error('STORAGE_LOST');
   if(sql==='BEGIN'){staged=clone(this.store);return {rows:[]}}
   if(sql==='COMMIT'){
    if(staged)this.store=staged;
    staged=undefined;
    if(this.loseNextCommitAcknowledgement){
      this.loseNextCommitAcknowledgement=false;
      throw Error('COMMIT_CONFIRMED_BY_DATABASE_ACK_LOST_ON_NETWORK');
    }
    return {rows:[]};
   }
   if(sql==='ROLLBACK'){staged=undefined;return {rows:[]}}
   const state=view(),v=values as string[];
   if(sql.startsWith('SELECT owner_id,epoch,generation,state')){
    const record=state.devices.get(v[0]!);
    return {rows:record?[{...record}]:[]};
   }
   if(sql.startsWith('SELECT sequence,device_id,owner_id,epoch,fingerprint,capability')){
    const row=state.reservations.get(v[0]!);
    return {rows:row?[{...row,sequence:String(row.sequence)}]:[]};
   }
   if(sql.startsWith('INSERT INTO witness_reservations')){
    const [requestId,device,owner,epoch,fingerprint,capability]=v;
    if(state.reservations.has(requestId!))return {rows:[]};
    const sequence=++state.sequence;
    state.reservations.set(requestId!,{
      device_id:device!,owner_id:owner!,epoch:epoch!,
      fingerprint:fingerprint!,capability:capability!,sequence,
    });
    return {rows:[{sequence:String(sequence)}]};
   }
   if(sql.startsWith('INSERT INTO witness_devices')){
    const [device,owner,epoch]=v;
    if(state.devices.has(device!))return {rows:[]};
    state.devices.set(device!,{owner_id:owner!,epoch:epoch!,
      generation:1,state:'active'});
    return {rows:[{generation:'1'}]};
   }
   if(sql.startsWith('UPDATE witness_devices SET owner_id=')){
    const [device,owner,epoch,newOwner,newEpoch,generation]=values;
    const row=state.devices.get(String(device));
    if(!row||row.owner_id!==owner||row.epoch!==epoch||
       row.generation!==generation||row.state!=='active')return {rows:[]};
    row.owner_id=String(newOwner);row.epoch=String(newEpoch);
    row.generation++;
    return {rows:[{generation:String(row.generation)}]};
   }
   if(sql.startsWith("UPDATE witness_devices SET state='frozen'")){
    const [device,epoch,owner]=values;
    const row=state.devices.get(String(device));
    if(!row||row.epoch!==epoch||row.owner_id!==owner||
       row.state!=='active')return {rows:[]};
    row.state='frozen';return {rows:[{generation:String(row.generation)}]};
   }
   throw Error('Unsupported SQL contract: '+sql);
  }};
 }
}
const approval='SIGNED_EXTERNAL_OWNER_APPROVAL_FIXTURE_'.repeat(2);
function fixture(){
 const pool=new DeterministicPgPool();
 const authorityId=randomUUID(),ownerId=randomUUID(),deviceId=randomUUID(),
  epoch=randomUUID(),anotherOwner=randomUUID(),nextEpoch=randomUUID();
 let proofValid=true,trust=true,expiry=Date.now()+60000;
 let authenticated:{ownerId:string;deviceId:string;epoch:string}={
  ownerId,deviceId,epoch,
 };
 const log:WitnessOperatorIntent[]=[];
 const make=()=>new PostgresMonotonicWitness({
  pool,authorityId,
  verifyProvenance:async()=>({
    verified:trust,authorityId,validUntil:expiry,
  }),
  resolvePrincipal:async(device,askedEpoch)=>device===authenticated.deviceId&&
   askedEpoch===authenticated.epoch?{...authenticated}:undefined,
  verifyOperatorApproval:async(intent,signedProof)=>{
   log.push(intent);
   return proofValid&&signedProof===approval;
  },
 });
 const request=(requestId=randomUUID(),fingerprint=fp,
   targetDevice=deviceId,requestEpoch=epoch)=>({
   deviceId:targetDevice,epoch:requestEpoch,requestId,
   fingerprint,capability:'files.write',
 });
 return {pool,authorityId,ownerId,deviceId,epoch,nextEpoch,anotherOwner,
  make,request,log,
  setTrust:(v:boolean)=>{trust=v},
  expire:()=>{expiry=Date.now()-1},
  setApproval:(v:boolean)=>{proofValid=v},
  switchPrincipal:(nextOwner:string,nextDevice=deviceId,changedEpoch=nextEpoch)=>{
   authenticated={ownerId:nextOwner,deviceId:nextDevice,epoch:changedEpoch};
  },
 };
}
const expectCode=async(p:Promise<unknown>,code:string)=>
 assert.rejects(p,{code});

test('atomic reservation is created once; owner, global UUID and fingerprint are fenced',async()=>{
 const f=fixture();const w=f.make();
 await w.enrollDevice({ownerId:f.ownerId,deviceId:f.deviceId,
  epoch:f.epoch,signedProof:approval});
 const id=randomUUID(),r=f.request(id);
 const concurrent=await Promise.all(Array.from({length:9},()=>w.reserve(r)));
 assert.equal(concurrent.filter(x=>x.created).length,1);
 assert.equal(new Set(concurrent.map(x=>x.sequence)).size,1);
 await expectCode(w.reserve(f.request(id,'a'.repeat(64))),'WITNESS_REQUEST_ID_REUSED');
 const attacker=randomUUID(),deviceB=randomUUID(),epochB=randomUUID();
 await w.enrollDevice({ownerId:attacker,deviceId:deviceB,
  epoch:epochB,signedProof:approval});
 f.switchPrincipal(attacker,deviceB,epochB);
 await expectCode(w.reserve(f.request(id,fp,deviceB,epochB)),
  'WITNESS_REQUEST_ID_REUSED');
 assert.equal(f.pool.store.reservations.size,1);
});
test('no signed operator proof or no independently validated provenance => fail closed',async()=>{
 const f=fixture();const w=f.make();
 await expectCode(w.enrollDevice({ownerId:f.ownerId,deviceId:f.deviceId,
  epoch:f.epoch,signedProof:'made-up'}),'WITNESS_OPERATOR_PROOF_INVALID');
 f.setApproval(false);
 await expectCode(w.enrollDevice({ownerId:f.ownerId,deviceId:f.deviceId,
  epoch:f.epoch,signedProof:approval}),'WITNESS_OPERATOR_PROOF_UNVERIFIED');
 f.setApproval(true);f.setTrust(false);
 await expectCode(w.enrollDevice({ownerId:f.ownerId,deviceId:f.deviceId,
  epoch:f.epoch,signedProof:approval}),'WITNESS_PROVENANCE_UNVERIFIED');
 f.setTrust(true);f.expire();
 await expectCode(w.reserve(f.request()),'WITNESS_PROVENANCE_UNVERIFIED');
 assert.equal(f.pool.store.reservations.size,0);
});
test('epoch-owner migration uses optimistic CAS; old owner/epoch can never reserve',async()=>{
 const f=fixture();const w=f.make();
 await w.enrollDevice({ownerId:f.ownerId,deviceId:f.deviceId,
  epoch:f.epoch,signedProof:approval});
 const historical=randomUUID();
 assert.equal((await w.reserve(f.request(historical))).created,true);
 f.setApproval(false);
 const input={deviceId:f.deviceId,expectedOwnerId:f.ownerId,
  expectedEpoch:f.epoch,expectedGeneration:1,newOwnerId:f.anotherOwner,
  newEpoch:f.nextEpoch,signedProof:approval};
 await expectCode(w.migrateOwnerEpoch(input),'WITNESS_OPERATOR_PROOF_UNVERIFIED');
 f.setApproval(true);
 assert.equal(await w.migrateOwnerEpoch(input),2);
 await expectCode(w.migrateOwnerEpoch(input),'WITNESS_MIGRATION_STALE');
 await expectCode(w.reserve(f.request()),'WITNESS_OWNER_EPOCH_FENCED');
 f.switchPrincipal(f.anotherOwner);
 await expectCode(w.reserve(f.request(historical,fp,f.deviceId,f.nextEpoch)),
  'WITNESS_REQUEST_ID_REUSED');
 const fresh=f.request(randomUUID(),fp,f.deviceId,f.nextEpoch);
 assert.equal((await w.reserve(fresh)).created,true);
 assert.equal(f.pool.store.reservations.size,2);
});
test('owner migration remains frozen across witness restart, lost Hub and local snapshot restore',async()=>{
 const f=fixture();let w=f.make();
 await w.enrollDevice({ownerId:f.ownerId,deviceId:f.deviceId,
  epoch:f.epoch,signedProof:approval});
 const original=f.request();
 assert.equal((await w.reserve(original)).created,true);
 const snapshot={localJournal:new Map(),hub:new Map(),gateway:new Map()};
 w=f.make(); // simulated process restart; independent pool retains durable state
 assert.equal((await w.reserve(original)).created,false);
 await w.migrateOwnerEpoch({deviceId:f.deviceId,
  expectedOwnerId:f.ownerId,expectedEpoch:f.epoch,
  expectedGeneration:1,newOwnerId:f.anotherOwner,
  newEpoch:f.nextEpoch,signedProof:approval});
 // Attacker restores Agent/Hub/gateway snapshot; independent authority unaffected.
 snapshot.localJournal.clear();snapshot.hub.clear();snapshot.gateway.clear();
 await expectCode(w.reserve(original),'WITNESS_OWNER_EPOCH_FENCED');
 f.switchPrincipal(f.anotherOwner);
 await expectCode(w.reserve(f.request(original.requestId,fp,f.deviceId,f.nextEpoch)),
  'WITNESS_REQUEST_ID_REUSED');
});
test('explicit freeze blocks current and new epochs without deleting tombstones',async()=>{
 const f=fixture(),w=f.make();
 await w.enrollDevice({ownerId:f.ownerId,deviceId:f.deviceId,
  epoch:f.epoch,signedProof:approval});
 const id=f.request();
 await w.reserve(id);
 await w.freezeDevice(f.deviceId,f.epoch,f.ownerId,approval);
 await expectCode(w.reserve(id),'WITNESS_OWNER_EPOCH_FENCED');
 await expectCode(w.reserve(f.request()),'WITNESS_OWNER_EPOCH_FENCED');
 assert.equal(f.pool.store.reservations.size,1);
});
test('storage unavailable mid-reservation yields no confirmed grant, preserving UNKNOWN',async()=>{
 const f=fixture(),w=f.make();
 await w.enrollDevice({ownerId:f.ownerId,deviceId:f.deviceId,
  epoch:f.epoch,signedProof:approval});
 f.pool.available=false;
 await assert.rejects(w.reserve(f.request()));
 assert.equal(f.pool.store.reservations.size,0);
});
test('lost acknowledgement after witness COMMIT is UNKNOWN, never a second created grant',async()=>{
 const f=fixture(),w=f.make();
 await w.enrollDevice({ownerId:f.ownerId,deviceId:f.deviceId,
  epoch:f.epoch,signedProof:approval});
 const request=f.request();
 f.pool.loseNextCommitAcknowledgement=true;
 await assert.rejects(w.reserve(request),/COMMIT_CONFIRMED/);
 assert.equal(f.pool.store.reservations.has(request.requestId),true);
 // This is an explicit read-only model check for duplicate provenance, NOT
 // a mutation executor automatic replay. External CAS would return 503 first.
 assert.equal((await w.reserve(request)).created,false);
});
test('rolled-back WITNESS storage itself remains an unproven release blocker',async()=>{
 const f=fixture(),w=f.make();
 await w.enrollDevice({ownerId:f.ownerId,deviceId:f.deviceId,
  epoch:f.epoch,signedProof:approval});
 const stale=clone(f.pool.store);
 const id=f.request();
 assert.equal((await w.reserve(id)).created,true);
 f.pool.store=stale; // physically restoring remote witness DB is a different threat
 assert.equal((await w.reserve(id)).created,true);
 // This EXPECTED vulnerability of storage snapshot rollback is NOT a PASS
 // of production anti-rollback. A physically protected trust anchor must
 // prevent exactly this restoration before shipping.
});
