/** #18 independent adversarial QA fixture copied from #676 test contract.
 * This is a SINGLE PROCESS PostgreSQL SQL simulator and in-memory remote CAS.
 * It does NOT attest physical external custody, durability, true multi-host concurrency,
 * real PostgreSQL, production service or independent monotonic protection.
 */
/** #01 SOURCE-INTEGRATION TEST ONLY.
 * PgContractPool and FakeExternalAuthority are deterministic test doubles:
 * NOT PostgreSQL, NOT immutable remote storage, NOT production attestation.
 * The REAL source PostgresBoundGrantCas and WitnessRevokeCoordinator execute.
 */
import {randomUUID} from 'node:crypto';
import {PostgresBoundGrantCas,type AuthenticatedGrantScope,
  type ExternalGrantCas,type ExternalGrantCasReceipt,type ExternalRevokeRequest,
  type ExternalRevokeReceipt,type ExternalRePairRequest,
  type ExternalRePairReceipt} from '../../src/agent/postgres-bound-grant-cas.js';
import {WitnessRevokeCoordinator} from '../../src/agent/witness-revoke-coordinator.js';
import {PostgresWitnessDelegation} from '../../src/agent/witness-delegation.js';
import type {CasRequest} from '../../src/agent/remote-mutation-cas.js';
import type {WitnessPgPool,WitnessPgConnection}
  from '../../src/agent/postgres-monotonic-witness.js';

const fp='c'.repeat(64);
type D={owner_id:string;epoch:string;generation:number;state:'active'};
type G={owner_id:string;epoch:string;session_epoch:string;generation:number;
  core_enabled:boolean;root_expires_ms:number|null;max_seen_ms:number};
type R={sequence:number;device_id:string;owner_id:string;epoch:string;
  fingerprint:string;capability:string};
type S={device:Map<string,D>;grant:Map<string,G>;
  reservations:Map<string,R>;clock:number};
export const copy=(s:S):S=>({
 device:new Map([...s.device].map(([k,v])=>[k,{...v}])),
 grant:new Map([...s.grant].map(([k,v])=>[k,{...v}])),
 reservations:new Map([...s.reservations].map(([k,v])=>[k,{...v}])),
 clock:s.clock,
});
class PgContractPool implements WitnessPgPool {
 state:S={device:new Map(),grant:new Map(),reservations:new Map(),clock:0};
 now=Date.now();
 failLocalWrite=false;
 failTransition=false;
 private tail:Promise<void>=Promise.resolve();
 async connect():Promise<WitnessPgConnection>{
  let unlock=()=>{};
  const gate=new Promise<void>(resolve=>{unlock=resolve});
  const previous=this.tail;this.tail=gate;await previous;
  let snapshot:S|undefined;
  const db=()=>snapshot??this.state;
  return {release:unlock,query:async(sql,values=[])=>{
   if(sql==='BEGIN'){snapshot=copy(this.state);return {rows:[]}}
   if(sql==='COMMIT'){if(snapshot)this.state=snapshot;snapshot=undefined;return {rows:[]}}
   if(sql==='ROLLBACK'){snapshot=undefined;return {rows:[]}}
   const s=db(),key=String(values[0]);
   if(sql.startsWith('SELECT owner_id,epoch,generation,state')){
    const v=s.device.get(key);return {rows:v?[{...v}]:[]};
   }
   if(sql.startsWith('SELECT owner_id,epoch,session_epoch,generation')){
    const v=s.grant.get(key);return {rows:v?[{...v}]:[]};
   }
   if(sql.startsWith('SELECT FLOOR(EXTRACT(EPOCH')){
    return {rows:[{now_ms:String(this.now)}]};
   }
   if(sql.startsWith('SELECT sequence,device_id,owner_id,epoch')){
    const v=s.reservations.get(key);
    return {rows:v?[{...v,sequence:String(v.sequence)}]:[]};
   }
   if(sql.startsWith('UPDATE witness_clock')){
    s.clock++;return {rows:[{last_sequence:String(s.clock)}]};
   }
   if(sql.startsWith('INSERT INTO witness_reservations')){
    if(this.failLocalWrite){this.failLocalWrite=false;throw Error('DISK_FULL')}
    const [seq,id,device,owner,epoch,fingerprint,capability]=values;
    if(s.reservations.has(String(id)))return {rows:[]};
    s.reservations.set(String(id),{sequence:Number(seq),
      device_id:String(device),owner_id:String(owner),epoch:String(epoch),
      fingerprint:String(fingerprint),capability:String(capability)});
    return {rows:[{sequence:String(seq)}]};
   }
   if(sql.startsWith('UPDATE witness_delegations SET max_seen_ms')){
    const v=s.grant.get(key);if(v)v.max_seen_ms=Number(values[1]);
    return {rows:[]};
   }
   if(sql.startsWith('UPDATE witness_delegations SET owner_id')){
    if(this.failTransition){this.failTransition=false;throw Error('DISK_FULL_TRANSITION')}
    const [device,owner,epoch,session,gen,core,root,now,expected]=values;
    const v=s.grant.get(String(device));
    if(!v||v.generation!==expected)return {rows:[]};
    Object.assign(v,{owner_id:String(owner),epoch:String(epoch),
      session_epoch:String(session),generation:Number(gen),
      core_enabled:Boolean(core),
      root_expires_ms:root===null?null:Number(root),max_seen_ms:Number(now)});
    return {rows:[{generation:v.generation}]};
   }
   if(sql.startsWith('UPDATE witness_devices SET owner_id')){
    const [device,owner,epoch,oldOwner,oldEpoch,gen]=values;
    const v=s.device.get(String(device));
    if(!v||v.owner_id!==oldOwner||v.epoch!==oldEpoch||
       v.generation!==gen)return {rows:[]};
    Object.assign(v,{owner_id:String(owner),epoch:String(epoch),
      generation:v.generation+1});
    return {rows:[{generation:v.generation}]};
   }
   throw Error('Unimplemented source SQL contract: '+sql);
  }};
 }
}
class FakeExternalAuthority implements ExternalGrantCas{
 private nextReserveGate?:{entered:()=>void;released:Promise<void>};
 private revokeSignal?:()=>void;
 pauseNextReserve(){
  if(this.nextReserveGate)throw Error('GATE_ALREADY_ARMED');
  let entered!:()=>void,release!:()=>void;
  const start=new Promise<void>(resolve=>entered=resolve);
  const stop=new Promise<void>(resolve=>release=resolve);
  this.nextReserveGate={entered,released:stop};
  return {entered:start,release};
 }
 whenRevokeIsExternallyCommitted(){
  return new Promise<void>(resolve=>{this.revokeSignal=resolve});
 }

 readonly reserved=new Map<string,ExternalGrantCasReceipt>();
 private next=0;
 generation=2;
 revoked=false;
 failUnknown=false;
 loseRevokeAckAfterCommit=false;
 constructor(readonly ids:{authorityId:string;deviceId:string;
  ownerId:string;epoch:string;session:string}){}
 async reserveIfCurrent(input:CasRequest,scope:AuthenticatedGrantScope):
  Promise<ExternalGrantCasReceipt>{
  const gate=this.nextReserveGate;
  if(gate){this.nextReserveGate=undefined;gate.entered();await gate.released;}
  if(this.failUnknown)throw Error('SIMULATED_LOST_ACK');
  if(this.revoked||scope.expectedGeneration!==this.generation||
     scope.deviceId!==this.ids.deviceId||scope.ownerId!==this.ids.ownerId||
     scope.deviceEpoch!==this.ids.epoch||scope.sessionEpoch!==this.ids.session)
   throw Error('EXTERNAL_FENCE_DENIED');
  const previous=this.reserved.get(input.requestId);
  if(previous){
   if(previous.fingerprint!==input.fingerprint||
      previous.capability!==input.capability)throw Error('ID_COLLISION');
   return {...previous,created:false};
  }
  const receipt:ExternalGrantCasReceipt={
   authorityId:this.ids.authorityId,deviceId:input.deviceId,epoch:input.epoch,
   requestId:input.requestId,ownerId:scope.ownerId,sessionEpoch:scope.sessionEpoch,
   grantGeneration:scope.expectedGeneration,fingerprint:input.fingerprint,
   capability:input.capability,sequence:++this.next,created:true,
  };
  this.reserved.set(input.requestId,receipt);return receipt;
 }
 async rePairIfCurrent(input:ExternalRePairRequest):Promise<ExternalRePairReceipt>{
  if(this.failUnknown)throw Error('SIMULATED_EXTERNAL_UNKNOWN');
  if(this.revoked||input.expectedGeneration!==this.generation||
     input.deviceId!==this.ids.deviceId||input.ownerId!==this.ids.ownerId||
     input.deviceEpoch!==this.ids.epoch||input.sessionEpoch!==this.ids.session||
     input.newDeviceEpoch===input.deviceEpoch||
     input.newSessionEpoch===input.sessionEpoch)
   throw Error('STALE_EXTERNAL_REPAIR');
  const previousGeneration=this.generation++;
  this.ids.ownerId=input.newOwnerId;
  this.ids.epoch=input.newDeviceEpoch;
  this.ids.session=input.newSessionEpoch;
  return {authorityId:this.ids.authorityId,deviceId:input.deviceId,
   ownerId:input.ownerId,deviceEpoch:input.deviceEpoch,
   sessionEpoch:input.sessionEpoch,previousGeneration,
   generation:this.generation,revoked:true,
   newOwnerId:input.newOwnerId,newDeviceEpoch:input.newDeviceEpoch,
   newSessionEpoch:input.newSessionEpoch,coreCleared:true};
 }
 async revokeIfCurrent(input:ExternalRevokeRequest):Promise<ExternalRevokeReceipt>{
  if(this.failUnknown)throw Error('SIMULATED_EXTERNAL_ACK_LOST');
  if(this.revoked||input.expectedGeneration!==this.generation||
     input.deviceId!==this.ids.deviceId||input.ownerId!==this.ids.ownerId||
     input.deviceEpoch!==this.ids.epoch||input.sessionEpoch!==this.ids.session)
   throw Error('STALE_EXTERNAL_REVOKE');
  this.revoked=true;this.generation++;this.revokeSignal?.();
  if(this.loseRevokeAckAfterCommit){
   this.loseRevokeAckAfterCommit=false;
   throw Error('ACK_LOST_AFTER_DURABLE_REVOKE');
  }
  return {authorityId:this.ids.authorityId,deviceId:input.deviceId,
   ownerId:input.ownerId,deviceEpoch:input.deviceEpoch,
   sessionEpoch:input.sessionEpoch,previousGeneration:input.expectedGeneration,
   generation:this.generation,revoked:true};
 }
}
export function fixture(overrides:{
 verifyOperatorApproval?:import('../../src/agent/postgres-monotonic-witness.js').IndependentOperatorApproval;
 verifyProvenance?:import('../../src/agent/postgres-monotonic-witness.js').IndependentProvenanceCheck;
}={}){
 const ids={authorityId:randomUUID(),deviceId:randomUUID(),
  ownerId:randomUUID(),epoch:randomUUID(),session:randomUUID()};
 const pg=new PgContractPool();
 pg.state.device.set(ids.deviceId,{owner_id:ids.ownerId,
  epoch:ids.epoch,generation:1,state:'active'});
 pg.state.grant.set(ids.deviceId,{owner_id:ids.ownerId,epoch:ids.epoch,
  session_epoch:ids.session,generation:2,core_enabled:true,
  root_expires_ms:null,max_seen_ms:pg.now});
 const external=new FakeExternalAuthority(ids);
 const scope:AuthenticatedGrantScope={
  deviceId:ids.deviceId,deviceEpoch:ids.epoch,ownerId:ids.ownerId,
  sessionEpoch:ids.session,expectedGeneration:2,requiredPrivilege:'CORE',
 };
 const prover=overrides.verifyProvenance??(async()=>({verified:true,authorityId:ids.authorityId,
  validUntil:Date.now()+60_000}));
 const identity=async(d:string,e:string)=>d===ids.deviceId&&e===ids.epoch?
  {ownerId:ids.ownerId,deviceId:d,epoch:e}:undefined;
 const createCas=()=>new PostgresBoundGrantCas({
  pool:pg,authorityId:ids.authorityId,verifyProvenance:prover,
  resolveAuthenticatedScope:async()=>scope,externalCas:external,
 });
 const delegation=new PostgresWitnessDelegation({
  pool:pg,authorityId:ids.authorityId,verifyProvenance:prover,
  resolvePrincipal:identity,verifySession:async v=>v.sessionEpoch===ids.session,
  verifyOperatorApproval:overrides.verifyOperatorApproval??(async()=>true), // TEST ONLY default
 });
 const coordinator=new WitnessRevokeCoordinator({
  pool:pg,external,authorityId:ids.authorityId,
  verifyPrincipal:identity,verifySession:async v=>v.sessionEpoch===ids.session,
  verifyOperatorApproval:async()=>true, // TEST ONLY
 });
 const request=(id=randomUUID()):CasRequest=>({
  deviceId:ids.deviceId,epoch:ids.epoch,requestId:id,
  fingerprint:fp,capability:'shell.exec',
 });
 const revoke=()=>({
  action:'revoke' as const,deviceId:ids.deviceId,ownerId:ids.ownerId,
  deviceEpoch:ids.epoch,sessionEpoch:ids.session,
  expectedGeneration:2,signedProof:'SIGNED_APPROVAL_FIXTURE_'.repeat(3),
 });
 return {ids,pg,external,scope,cas:createCas(),createCas,delegation,coordinator,request,revoke};
}
