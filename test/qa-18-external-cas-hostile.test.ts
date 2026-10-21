/**
 * #18 independent hostile QA. Only a deterministic SQL contract emulator.
 * Nothing here is a real PostgreSQL cluster, protected remote authority,
 * deployment attestation, UAC session, or authorized OS privilege.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import {PostgresMonotonicWitness,type WitnessPgPool,
  type WitnessPgConnection,type WitnessOperatorIntent}
  from '../src/agent/postgres-monotonic-witness.js';
import {PostgresWitnessDelegation,type DelegationChange}
  from '../src/agent/witness-delegation.js';
import {signedOperatorGrantVerifier,signedProvenanceVerifier}
  from '../src/agent/witness-signed-provenance.js';

type Device={owner_id:string;epoch:string;generation:number;state:string};
type Reservation={sequence:number;device_id:string;owner_id:string;
  epoch:string;fingerprint:string;capability:string};
type Delegation={owner_id:string;epoch:string;session_epoch:string;
  generation:number;core_enabled:boolean;root_expires_ms:number|null;
  max_seen_ms:number};
type Store={devices:Map<string,Device>;reservations:Map<string,Reservation>;
  delegations:Map<string,Delegation>;sequence:number};
function copy(s:Store):Store{return {
  devices:new Map([...s.devices].map(([k,v])=>[k,{...v}])),
  reservations:new Map([...s.reservations].map(([k,v])=>[k,{...v}])),
  delegations:new Map([...s.delegations].map(([k,v])=>[k,{...v}])),
  sequence:s.sequence,
};}

/** Serialized SQL semantics only: never evidence of actual PG isolation/fsync. */
class HostilePool implements WitnessPgPool {
  state:Store={devices:new Map(),reservations:new Map(),
    delegations:new Map(),sequence:0};
  now=Date.now();
  available=true;
  loseCommitAck=false;
  private previous:Promise<void>=Promise.resolve();
  async connect():Promise<WitnessPgConnection>{
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
function fixture(){
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
const denied=(p:Promise<unknown>,code:string)=>assert.rejects(p,{code});

test('#18 two independent Hubs: one winner for 24 concurrent same-ID CAS calls',async()=>{
  const f=fixture();await f.enroll();
  const a=f.hub(),b=f.hub(),id=randomUUID();
  const results=await Promise.all(Array.from({length:24},(_,i)=>
    (i%2?a:b).reserve(f.request(id))));
  assert.equal(results.filter(x=>x.created).length,1);
  assert.equal(new Set(results.map(x=>x.sequence)).size,1);
  assert.equal(f.pool.state.sequence,1);
  assert.equal(f.pool.state.reservations.size,1);
});

test('#18 global request-ID tombstone rejects cross-owner/device epoch and fingerprint',async()=>{
  const f=fixture();await f.enroll();
  const id=randomUUID();
  assert.equal((await f.hub().reserve(f.request(id))).created,true);
  const owner2=randomUUID(),device2=randomUUID(),epoch2=randomUUID();
  await f.enroll(device2,owner2,epoch2);
  await denied(f.hub().reserve(f.request(id,device2,epoch2)),
    'WITNESS_REQUEST_ID_REUSED');
  await denied(f.hub().reserve({...f.request(id),fingerprint:'b'.repeat(64)}),
    'WITNESS_REQUEST_ID_REUSED');
  await denied(f.hub().reserve(f.request(randomUUID(),f.deviceId,randomUUID())),
    'WITNESS_OWNER_UNAUTHORIZED');
  assert.equal(f.pool.state.reservations.size,1);
});

test('#18 forged signed witness provenance denies before the database connection',async()=>{
  const f=fixture();await f.enroll();
  const before=f.pool.state.sequence;
  f.invalidateSignature();
  await denied(f.hub().reserve(f.request()),'WITNESS_PROVENANCE_UNVERIFIED');
  await denied(f.delegation().evaluate(f.identity()),
    'DELEGATION_PROVENANCE_UNVERIFIED');
  assert.equal(f.pool.state.sequence,before);
  f.restoreSignature();
  assert.equal((await f.hub().reserve(f.request())).created,true);
});

test('#18 local Agent journal + Hub cache restore cannot make preserved witness ID new',async()=>{
  const f=fixture();await f.enroll();
  let localJournal=new Map<string,string>();
  const snapshot=new Map(localJournal);
  const oldId=randomUUID(),currentId=randomUUID();
  await f.hub().reserve(f.request(oldId));localJournal.set(oldId,'reserved');
  await f.hub().reserve(f.request(currentId));localJournal.set(currentId,'unknown');
  localJournal=new Map(snapshot); // Simulate co-rollback of LOCAL authority/cache only.
  assert.equal(localJournal.has(currentId),false);
  const fromOtherHub=await f.hub().reserve(f.request(currentId));
  assert.equal(fromOtherHub.created,false);
  assert.equal(f.pool.state.reservations.size,2);
  assert.equal(f.pool.state.sequence,2);
});

test('#18 lost commit acknowledgment is UNKNOWN, never a successful first-dispatch',async()=>{
  const f=fixture();await f.enroll();
  const id=randomUUID();f.pool.loseCommitAck=true;
  await assert.rejects(f.hub().reserve(f.request(id)),/SIMULATED_COMMIT_ACK_LOST/);
  assert.equal(f.pool.state.reservations.has(id),true);
  assert.equal((await f.hub().reserve(f.request(id))).created,false);
  f.pool.available=false;
  await denied(f.hub().reserve(f.request()),'WITNESS_STORAGE_UNAVAILABLE');
});

test('#18 signed owner scope/session epoch forged or stale CORE grant cannot revive revoke',async()=>{
  const f=fixture();await f.enroll();
  const g=f.delegation();
  await g.change(f.change('bind_session',0));
  const stale=f.change('grant_core',1);
  await denied(g.change(f.forgeGrant(stale)),
    'DELEGATION_OWNER_APPROVAL_UNVERIFIED');
  await denied(g.change(f.change('grant_core',1,{sessionEpoch:randomUUID()})),
    'DELEGATION_IDENTITY_UNVERIFIED');
  assert.equal((await g.change(stale)).mode,'CORE');
  assert.equal((await g.change(f.change('revoke',2))).mode,'NONE');
  await denied(g.change(stale),'DELEGATION_STALE_GENERATION');
  assert.equal((await f.delegation().evaluate(f.identity())).mode,'NONE');
});

test('#18 ROOT exactly 900000ms while verified CORE persists across restart and rotation',async()=>{
  const f=fixture();await f.enroll();
  const g=f.delegation();await g.change(f.change('bind_session',0));
  await g.change(f.change('grant_core',1));
  const root=await g.change(f.change('grant_root',2));
  assert.equal(root.rootExpiresAtMs,f.pool.now+900_000);
  f.pool.now+=899_999;
  assert.equal((await f.delegation().evaluate(f.identity())).mode,'ROOT');
  f.pool.now+=1;
  assert.equal((await f.delegation().evaluate(f.identity())).mode,'CORE');
  const nextSession=randomUUID();f.sessions.add(nextSession);
  assert.equal((await g.change(f.change('rotate_session',3,{
    newSessionEpoch:nextSession,
  }))).mode,'CORE');
  await denied(f.delegation().evaluate(f.identity()),'DELEGATION_SESSION_FENCED');
  assert.equal((await f.delegation().evaluate(f.identity(
    f.ownerId,f.deviceId,f.epoch,nextSession))).corePersisted,true);
  assert.equal((await g.change(f.change('revoke',4,{},f.ownerId,
    f.deviceId,f.epoch,nextSession))).mode,'NONE');
});

test('#18 re-pair fences old owner/device/session and clears CORE + ROOT atomically',async()=>{
  const f=fixture();await f.enroll();
  const g=f.delegation();await g.change(f.change('bind_session',0));
  await g.change(f.change('grant_core',1));
  await g.change(f.change('grant_root',2));
  const newOwner=randomUUID(),newEpoch=randomUUID(),newSession=randomUUID();
  const originalGrant=f.change('grant_core',2);
  const result=await g.change(f.change('re_pair',3,{
    newOwnerId:newOwner,newDeviceEpoch:newEpoch,newSessionEpoch:newSession,
  }));
  assert.equal(result.mode,'NONE');
  await denied(g.evaluate(f.identity()),'DELEGATION_IDENTITY_UNVERIFIED');
  await denied(f.hub().reserve(f.request()),'WITNESS_OWNER_UNAUTHORIZED');
  await denied(g.change(originalGrant),'DELEGATION_IDENTITY_UNVERIFIED');
  f.sessions.add(newSession);
  assert.equal((await f.delegation().evaluate(f.identity(newOwner,
    f.deviceId,newEpoch,newSession))).mode,'NONE');
});

test('#18 concurrent CORE grants use one generation, no duplicate privilege transition',async()=>{
  const f=fixture();await f.enroll();
  await f.delegation().change(f.change('bind_session',0));
  const c=f.change('grant_core',1);
  const outcomes=await Promise.allSettled([
    f.delegation().change(c),f.delegation().change(c)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
  assert.equal((await f.delegation().evaluate(f.identity())).generation,2);
});

test('#18 NEGATIVE physical gate: rolling back the WITNESS ITSELF resurrects UUID',async()=>{
  const f=fixture();await f.enroll();
  const before=copy(f.pool.state);
  const id=randomUUID();
  assert.equal((await f.hub().reserve(f.request(id))).created,true);
  // Model a hostile authoritative DB restore, not merely local Agent restore.
  // This intentionally documents a release-blocking vulnerability in the
  // synthetic storage model; PASS must NOT be called physical anti-rollback.
  f.pool.state=copy(before);
  assert.equal((await f.hub().reserve(f.request(id))).created,true);
  assert.equal(f.pool.state.sequence,1);
});