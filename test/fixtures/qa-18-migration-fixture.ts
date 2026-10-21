/**
 * #18 independent fixture for SOURCE-only cross-Hub migration/rollback QA.
 * The SQL pool serializes transactions in process memory. Not PostgreSQL,
 * not an actual external CAS authority, not restore-independent storage.
 * Ephemeral Ed25519 keys are fixture keys, not operator credentials.
 */
import {generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import {PostgresMonotonicWitness,type WitnessPgPool,
  type WitnessPgConnection,type WitnessOperatorIntent}
  from '../../src/agent/postgres-monotonic-witness.js';
import {PostgresWitnessDelegation,type DelegationChange}
  from '../../src/agent/witness-delegation.js';
import {signedOperatorGrantVerifier,signedProvenanceVerifier}
  from '../../src/agent/witness-signed-provenance.js';

type Device={owner_id:string;epoch:string;generation:number;state:string};
type Reservation={sequence:number;device_id:string;owner_id:string;
  epoch:string;fingerprint:string;capability:string};
type Delegation={owner_id:string;epoch:string;session_epoch:string;
  generation:number;core_enabled:boolean;root_expires_ms:number|null;
  max_seen_ms:number};
type Store={devices:Map<string,Device>;reservations:Map<string,Reservation>;
  delegations:Map<string,Delegation>;sequence:number};
export function copy(s:Store):Store{return {
  devices:new Map([...s.devices].map(([k,v])=>[k,{...v}])),
  reservations:new Map([...s.reservations].map(([k,v])=>[k,{...v}])),
  delegations:new Map([...s.delegations].map(([k,v])=>[k,{...v}])),
  sequence:s.sequence,
};}

/** Serialized SQL semantics only: never evidence of actual PG isolation/fsync. */
export class HostilePool implements WitnessPgPool {
  state:Store={devices:new Map(),reservations:new Map(),
    delegations:new Map(),sequence:0};
  now=Date.now();
  available=true;
  loseCommitAck=false;
  private previous:Promise<void>=Promise.resolve();
  private nextGate?:{entered:()=>void;released:Promise<void>};
  /**
   * Barrier after caller provenance + principal validation, BEFORE its SQL
   * transaction. Another synthetic Hub can revoke or re-pair first.
   * This is a deterministic ordering fixture, not a real PG network lock.
   */
  pauseNextConnection():{entered:Promise<void>;release:()=>void}{
    if(this.nextGate)throw Error('GATE_ALREADY_ARMED');
    let entered!:()=>void,released!:()=>void;
    const hit=new Promise<void>(resolve=>{entered=resolve;});
    const hold=new Promise<void>(resolve=>{released=resolve;});
    this.nextGate={entered,released:hold};
    return {entered:hit,release:released};
  }
  async connect():Promise<WitnessPgConnection>{
    const gate=this.nextGate;
    if(gate){
      this.nextGate=undefined;gate.entered();await gate.released;
    }
    if(!this.available)throw Error('SIMULATED_WITNESS_OFFLINE');
    let unlock=()=>{};
    const next=new Promise<void>(resolve=>{unlock=resolve});
    const prior=this.previous;this.previous=next;await prior;
    let staged:Store|undefined;
    const current=()=>staged??this.state;
    return {release:unlock,query:async(sql,values=[])=>{
      if(!this.available)throw Error('SIMULATED_DISCONNECTED');
      if(sql==='BEGIN'){staged=copy(this.state);return {rows:[]};}
      if(sql==='COMMIT'){
        if(staged)this.state=staged;
        staged=undefined;
        if(this.loseCommitAck){
          this.loseCommitAck=false;
          throw Error('SIMULATED_COMMIT_ACK_LOST');
        }
        return {rows:[]};
      }
      if(sql==='ROLLBACK'){staged=undefined;return {rows:[]};}
      const s=current();
      const key=String(values[0]);
      if(sql.startsWith('SELECT FLOOR(EXTRACT(EPOCH')){
        return {rows:[{now_ms:String(this.now)}]};
      }
      if(sql.startsWith('SELECT owner_id,epoch,generation,state')){
        const row=s.devices.get(key);return {rows:row?[{...row}]:[]};
      }
      if(sql.startsWith('SELECT sequence,device_id,owner_id,epoch,fingerprint')){
        const row=s.reservations.get(key);
        return {rows:row?[{...row,sequence:String(row.sequence)}]:[]};
      }
      if(sql.startsWith('UPDATE witness_clock SET last_sequence')){
        s.sequence++;
        return {rows:[{last_sequence:String(s.sequence)}]};
      }
      if(sql.startsWith('INSERT INTO witness_reservations')){
        const [sequence,request,device,owner,epoch,fingerprint,capability]=values;
        if(s.reservations.has(String(request)))return {rows:[]};
        s.reservations.set(String(request),{
          sequence:Number(sequence),device_id:String(device),owner_id:String(owner),
          epoch:String(epoch),fingerprint:String(fingerprint),
          capability:String(capability),
        });
        return {rows:[{sequence:String(sequence)}]};
      }
      if(sql.startsWith('INSERT INTO witness_devices')){
        const [device,owner,epoch]=values;
        if(s.devices.has(String(device)))return {rows:[]};
        s.devices.set(String(device),{owner_id:String(owner),
          epoch:String(epoch),generation:1,state:'active'});
        return {rows:[{generation:'1'}]};
      }
      if(sql.startsWith('SELECT owner_id,epoch,session_epoch,generation')){
        const row=s.delegations.get(key);return {rows:row?[{...row}]:[]};
      }
      if(sql.startsWith('INSERT INTO witness_delegations')){
        const [device,owner,epoch,session,now]=values;
        if(s.delegations.has(String(device)))throw Error('SIMULATED_DUPLICATE');
        s.delegations.set(String(device),{owner_id:String(owner),
          epoch:String(epoch),session_epoch:String(session),generation:1,
          core_enabled:false,root_expires_ms:null,max_seen_ms:Number(now)});
        return {rows:[]};
      }
      if(sql.startsWith('UPDATE witness_delegations SET max_seen_ms')){
        const row=s.delegations.get(key);
        if(row)row.max_seen_ms=Number(values[1]);
        return {rows:[]};
      }
      if(sql.startsWith('UPDATE witness_devices SET owner_id')){
        const [device,newOwner,newEpoch,oldOwner,oldEpoch,generation]=values;
        const row=s.devices.get(String(device));
        if(!row||row.owner_id!==oldOwner||row.epoch!==oldEpoch||
          row.generation!==generation||row.state!=='active')return {rows:[]};
        row.owner_id=String(newOwner);row.epoch=String(newEpoch);
        row.generation++;
        return {rows:[{generation:row.generation}]};
      }
      if(sql.startsWith('UPDATE witness_delegations SET owner_id')){
        const [device,owner,epoch,session,generation,core,root,now,expected]=values;
        const row=s.delegations.get(String(device));
        if(!row||row.generation!==expected)return {rows:[]};
        Object.assign(row,{owner_id:String(owner),epoch:String(epoch),
          session_epoch:String(session),generation:Number(generation),
          core_enabled:core===true,root_expires_ms:root===null?null:Number(root),
          max_seen_ms:Number(now)});
        return {rows:[{generation:row.generation}]};
      }
      throw Error('Unexpected simulated query: '+sql);
    }};
  }
}
function envelope(payload:Record<string,unknown>,key:KeyObject):string{
  const bytes=Buffer.from(JSON.stringify(payload));
  return JSON.stringify({payload:bytes.toString('base64url'),
    signature:sign(null,bytes,key).toString('base64url')});
}
const fp='a'.repeat(64);
export function fixture(){
  const pool=new HostilePool();
  const authorityId=randomUUID(),ownerId=randomUUID(),deviceId=randomUUID(),
    epoch=randomUUID(),sessionEpoch=randomUUID();
  const deploymentId=randomUUID(),witnessDomainId=randomUUID(),
    agentRollbackDomainId=randomUUID();
  const key=generateKeyPairSync('ed25519');
  const intruder=generateKeyPairSync('ed25519');
  const publicKey=key.publicKey.export({type:'spki',format:'pem'}).toString();
  const sessions=new Set<string>([sessionEpoch]);
  const signedProvenance=()=>envelope({
    version:1,authorityId,deploymentId,witnessDomainId,agentRollbackDomainId,
    independentlyOperated:true,immutableRetentionVerified:true,
    issuedAt:Date.now()-1000,expiresAt:Date.now()+60_000,
  },key.privateKey);
  let asserted=signedProvenance();
  const trusted=signedProvenanceVerifier({
    trustedEd25519PublicKeyPem:publicKey,authorityId,
    expectedDeploymentId:deploymentId,expectedWitnessDomainId:witnessDomainId,
    expectedAgentRollbackDomainId:agentRollbackDomainId,
    fetchSignedAssertion:async()=>asserted,
  });
  const principal=async(dev:string,e:string)=>{
    const d=pool.state.devices.get(dev);
    return d&&d.epoch===e&&d.state==='active'
      ?{ownerId:d.owner_id,deviceId:dev,epoch:e}:undefined;
  };
  const operator=signedOperatorGrantVerifier(publicKey);
  const hub=()=>new PostgresMonotonicWitness({
    pool,authorityId,verifyProvenance:trusted,resolvePrincipal:principal,
    verifyOperatorApproval:operator,
  });
  const delegation=()=>new PostgresWitnessDelegation({
    pool,authorityId,verifyProvenance:trusted,resolvePrincipal:principal,
    verifyOperatorApproval:operator,
    verifySession:async id=>sessions.has(id.sessionEpoch),
  });
  const signed=(intent:WitnessOperatorIntent,secret=key.privateKey)=>
    envelope({version:1,intent,nonce:randomUUID(),
      issuedAt:Date.now()-1000,expiresAt:Date.now()+60_000},secret);
  const enroll=async(dev=deviceId,owner=ownerId,e=epoch)=>{
    const intent:WitnessOperatorIntent={kind:'enroll',authorityId,
      deviceId:dev,ownerId:owner,epoch:e};
    await hub().enrollDevice({deviceId:dev,ownerId:owner,epoch:e,
      signedProof:signed(intent)});
  };
  const request=(requestId=randomUUID(),dev=deviceId,e=epoch)=>({
    requestId,deviceId:dev,epoch:e,fingerprint:fp,capability:'files.write',
  });
  const change=(action:DelegationChange['action'],generation:number,
    extra:Partial<Omit<DelegationChange,'action'|'expectedGeneration'|'signedProof'>>={},
    owner=ownerId,dev=deviceId,e=epoch,sess=sessionEpoch)=>{
    const c={action,deviceId:dev,ownerId:owner,deviceEpoch:e,
      sessionEpoch:sess,expectedGeneration:generation,...extra};
    const intent:WitnessOperatorIntent={kind:c.action,authorityId,
      deviceId:c.deviceId,ownerId:c.ownerId,epoch:c.deviceEpoch,
      sessionEpoch:c.sessionEpoch,generation:c.expectedGeneration,
      nextSessionEpoch:c.newSessionEpoch,nextOwnerId:c.newOwnerId,
      nextEpoch:c.newDeviceEpoch};
    return {...c,signedProof:signed(intent)};
  };
  const identity=(owner=ownerId,dev=deviceId,e=epoch,sess=sessionEpoch)=>({
    ownerId:owner,deviceId:dev,deviceEpoch:e,sessionEpoch:sess,
  });
  return {pool,authorityId,ownerId,deviceId,epoch,sessionEpoch,
    sessions,hub,delegation,request,change,identity,enroll,
    invalidateSignature:()=>{asserted=envelope({
      version:1,authorityId,deploymentId,witnessDomainId,agentRollbackDomainId,
      independentlyOperated:true,immutableRetentionVerified:true,
      issuedAt:Date.now()-1000,expiresAt:Date.now()+60_000,
    },intruder.privateKey);},
    restoreSignature:()=>{asserted=signedProvenance();},
    forgeGrant:(c:DelegationChange):DelegationChange=>{
      const intent:WitnessOperatorIntent={kind:c.action,authorityId,
        deviceId:c.deviceId,ownerId:c.ownerId,epoch:c.deviceEpoch,
        sessionEpoch:c.sessionEpoch,generation:c.expectedGeneration};
      return {...c,signedProof:signed(intent,intruder.privateKey)};
    },
  };
}
