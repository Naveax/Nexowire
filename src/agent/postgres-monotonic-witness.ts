import * as z from 'zod';
import type {CasRequest,CasReservation,MonotonicTrustRoot} from './remote-mutation-cas.js';

const id=z.string().uuid();
const hex=z.string().regex(/^[0-9a-f]{64}$/);
const requestSchema=z.object({
  deviceId:id,epoch:id,requestId:id,fingerprint:hex,
  capability:z.string().min(1).max(128),
}).strict();

/** Implement with a real external PostgreSQL pool (such as pg.Pool). */
export interface WitnessPgPool {
  connect():Promise<WitnessPgConnection>;
}
export interface WitnessPgConnection {
  query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;
  release():void;
}
export class WitnessAuthorityError extends Error {
  constructor(readonly code:string){
    super('Authoritative monotonic witness denied the requested operation.');
    this.name='WitnessAuthorityError';
  }
}
function denied(code:string):never{throw new WitnessAuthorityError(code)}
function count(value:unknown):number{
  const n=typeof value==='string'?Number(value):value;
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<1)
    denied('WITNESS_INVALID_SEQUENCE');
  return n as number;
}
function same(a:unknown,b:string):boolean{return a===b}
function validId(value:string):string{
  if(!id.safeParse(value).success)denied('WITNESS_ID_INVALID');
  return value;
}

export interface TrustedDevicePrincipal{
  ownerId:string;
  deviceId:string;
  epoch:string;
}
/**
 * The authentication layer MUST derive owner/device/epoch from a verified
 * credential. The request body cannot issue or modify enrollment.
 */
export type VerifiedPrincipalResolver =
  (deviceId:string,epoch:string)=>Promise<TrustedDevicePrincipal|undefined>;

/**
 * A required, external attestation gate. It must verify operator-signed
 * provenance and that the backing service's restore boundary is independent
 * of the Agent+gateway snapshot. This callback is NOT itself such proof.
 */
export type IndependentProvenanceCheck =
  ()=>Promise<{verified:boolean;authorityId:string;validUntil:number}>;

export interface WitnessOperatorIntent {
  kind:'enroll'|'migrate'|'freeze';
  authorityId:string;deviceId:string;ownerId:string;epoch:string;
  nextOwnerId?:string;nextEpoch?:string;generation?:number;
}
/**
 * Implementation must verify a scope-bound, expiring, signed authorization
 * from a separately protected owner/operator identity. Boolean flags supplied
 * in request bodies are NOT authorization.
 */
export type IndependentOperatorApproval =
  (intent:WitnessOperatorIntent,signedProof:string)=>Promise<boolean>;

type Enrolled={owner_id:unknown;epoch:unknown;generation:unknown;state:unknown};
type Stored={
  sequence:unknown;device_id:unknown;owner_id:unknown;epoch:unknown;
  fingerprint:unknown;capability:unknown;
};

/**
 * Atomic PostgreSQL conditional-create witness. The PostgreSQL database must
 * reside in a rollback-independent trust domain; PostgreSQL/WAL/UNIQUE alone
 * DO NOT protect against an administrator restoring the database itself.
 *
 * The schema is in sql/agent-monotonic-witness.sql.
 */
export class PostgresMonotonicWitness implements MonotonicTrustRoot {
  constructor(readonly config:{
    pool:WitnessPgPool;authorityId:string;
    resolvePrincipal:VerifiedPrincipalResolver;
    verifyProvenance:IndependentProvenanceCheck;
    verifyOperatorApproval:IndependentOperatorApproval;
  }){
    validId(config.authorityId);
  }

  private async trusted():Promise<void>{
    let proof;
    try{proof=await this.config.verifyProvenance()}catch{
      denied('WITNESS_PROVENANCE_UNAVAILABLE');
    }
    if(!proof||proof.verified!==true||
       proof.authorityId!==this.config.authorityId||
       !Number.isFinite(proof.validUntil)||proof.validUntil<=Date.now())
      denied('WITNESS_PROVENANCE_UNVERIFIED');
  }

  private async authenticated(deviceId:string,epoch:string):
    Promise<TrustedDevicePrincipal>{
    let principal;
    try{principal=await this.config.resolvePrincipal(deviceId,epoch)}
    catch{denied('WITNESS_OWNER_UNAVAILABLE')}
    if(!principal||!id.safeParse(principal.ownerId).success||
       principal.deviceId!==deviceId||principal.epoch!==epoch)
      denied('WITNESS_OWNER_UNAUTHORIZED');
    return principal;
  }

  private async transaction<T>(
    fn:(connection:WitnessPgConnection)=>Promise<T>):Promise<T>{
    const connection=await this.config.pool.connect().catch(()=>{
      return denied('WITNESS_STORAGE_UNAVAILABLE');
    });
    let active=false;
    try{
      await connection.query('BEGIN');
      active=true;
      const value=await fn(connection);
      await connection.query('COMMIT');
      active=false;
      return value;
    }catch(e){
      if(active){try{await connection.query('ROLLBACK')}catch{}}
      throw e;
    }finally{connection.release()}
  }

  async reserve(raw:CasRequest):Promise<CasReservation>{
    const input=requestSchema.parse(raw);
    await this.trusted();
    const principal=await this.authenticated(input.deviceId,input.epoch);
    return this.transaction(async connection=>{
      const entry=(await connection.query(
        'SELECT owner_id,epoch,generation,state FROM witness_devices '+
        'WHERE device_id=$1 FOR UPDATE',[input.deviceId])).rows[0] as
        Enrolled|undefined;
      if(!entry||entry.state!=='active'||
         !same(entry.owner_id,principal.ownerId)||
         !same(entry.epoch,input.epoch))
        denied('WITNESS_OWNER_EPOCH_FENCED');
      const previous=(await connection.query(
        'SELECT sequence,device_id,owner_id,epoch,fingerprint,capability '+
        'FROM witness_reservations WHERE request_id=$1',[input.requestId]))
        .rows[0] as Stored|undefined;
      if(previous){
        if(!same(previous.device_id,input.deviceId)||
           !same(previous.owner_id,principal.ownerId)||
           !same(previous.epoch,input.epoch)||
           !same(previous.fingerprint,input.fingerprint)||
           !same(previous.capability,input.capability))
          denied('WITNESS_REQUEST_ID_REUSED');
        return {authorityId:this.config.authorityId,
          deviceId:input.deviceId,epoch:input.epoch,
          requestId:input.requestId,sequence:count(previous.sequence),
          created:false};
      }
      // A PostgreSQL IDENTITY sequence is not ordered by transaction COMMIT.
      // The single counter row is locked until COMMIT, producing strict
      // global commit-ordered reservation sequence across all devices.
      const clock=(await connection.query(
        'UPDATE witness_clock SET last_sequence=last_sequence+1 '+
        'WHERE id=1 RETURNING last_sequence')).rows[0] as
        {last_sequence:unknown}|undefined;
      if(!clock)denied('WITNESS_CLOCK_MISSING');
      const sequence=count(clock.last_sequence);
      const inserted=(await connection.query(
        'INSERT INTO witness_reservations '+
        '(sequence,request_id,device_id,owner_id,epoch,fingerprint,capability) '+
        'VALUES($1,$2,$3,$4,$5,$6,$7) '+
        'ON CONFLICT (request_id) DO NOTHING RETURNING sequence',
        [sequence,input.requestId,input.deviceId,principal.ownerId,
          input.epoch,input.fingerprint,input.capability])).rows[0] as
        {sequence:unknown}|undefined;
      // Cross-device/owner UUID collision must roll back the clock too.
      if(!inserted||count(inserted.sequence)!==sequence)
        denied('WITNESS_REQUEST_ID_CONFLICT');
      return {authorityId:this.config.authorityId,deviceId:input.deviceId,
        epoch:input.epoch,requestId:input.requestId,
        sequence,created:true};
    });
  }

  private async operatorApproval(intent:WitnessOperatorIntent,signedProof:string):
    Promise<void>{
    if(typeof signedProof!=='string'||signedProof.length<32||
       signedProof.length>8192)denied('WITNESS_OPERATOR_PROOF_INVALID');
    let approved=false;
    try{approved=await this.config.verifyOperatorApproval(intent,signedProof)}
    catch{denied('WITNESS_OPERATOR_PROOF_UNVERIFIED')}
    if(approved!==true)denied('WITNESS_OPERATOR_PROOF_UNVERIFIED');
  }

  /** Explicit external signature; no silent auto-enrollment at startup. */
  async enrollDevice(approved:{
    ownerId:string;deviceId:string;epoch:string;signedProof:string;
  }):Promise<void>{
    validId(approved.ownerId);validId(approved.deviceId);validId(approved.epoch);
    await this.trusted();
    await this.operatorApproval({kind:'enroll',authorityId:this.config.authorityId,
      ownerId:approved.ownerId,deviceId:approved.deviceId,epoch:approved.epoch},
      approved.signedProof);
    await this.transaction(async connection=>{
      const row=await connection.query(
        'INSERT INTO witness_devices(device_id,owner_id,epoch,generation,state) '+
        "VALUES($1,$2,$3,1,'active') "+
        'ON CONFLICT (device_id) DO NOTHING RETURNING generation',
        [approved.deviceId,approved.ownerId,approved.epoch]);
      if(row.rows.length!==1)denied('WITNESS_DEVICE_ALREADY_ENROLLED');
    });
  }

  /** Owner/epoch switch is compare-and-swap, preserving historical tombstones. */
  async migrateOwnerEpoch(approved:{
    deviceId:string;expectedOwnerId:string;expectedEpoch:string;
    expectedGeneration:number;newOwnerId:string;newEpoch:string;
    signedProof:string;
  }):Promise<number>{
    for(const s of [approved.deviceId,approved.expectedOwnerId,
      approved.expectedEpoch,approved.newOwnerId,approved.newEpoch])validId(s);
    if(approved.newEpoch===approved.expectedEpoch||
       !Number.isSafeInteger(approved.expectedGeneration)||
       approved.expectedGeneration<1)
      denied('WITNESS_MIGRATION_NOT_APPROVED');
    await this.trusted();
    await this.operatorApproval({kind:'migrate',authorityId:this.config.authorityId,
      deviceId:approved.deviceId,ownerId:approved.expectedOwnerId,
      epoch:approved.expectedEpoch,nextOwnerId:approved.newOwnerId,
      nextEpoch:approved.newEpoch,generation:approved.expectedGeneration},
      approved.signedProof);
    return this.transaction(async connection=>{
      const row=(await connection.query(
        'UPDATE witness_devices SET owner_id=$4,epoch=$5,'+
        'generation=generation+1 WHERE device_id=$1 AND owner_id=$2 '+
        "AND epoch=$3 AND generation=$6 AND state='active' "+
        'RETURNING generation',
        [approved.deviceId,approved.expectedOwnerId,approved.expectedEpoch,
          approved.newOwnerId,approved.newEpoch,
          approved.expectedGeneration])).rows[0] as
          {generation:unknown}|undefined;
      if(!row)denied('WITNESS_MIGRATION_STALE');
      return count(row.generation);
    });
  }

  /** Explicit lockdown before restore or suspicious identity custody. */
  async freezeDevice(deviceId:string,expectedEpoch:string,
    expectedOwnerId:string,signedProof:string):Promise<void>{
    validId(deviceId);validId(expectedEpoch);validId(expectedOwnerId);
    await this.trusted();
    await this.operatorApproval({kind:'freeze',authorityId:this.config.authorityId,
      deviceId,ownerId:expectedOwnerId,epoch:expectedEpoch},signedProof);
    await this.transaction(async connection=>{
      const row=await connection.query(
        "UPDATE witness_devices SET state='frozen' "+
        "WHERE device_id=$1 AND epoch=$2 AND owner_id=$3 AND state='active' "+
        'RETURNING generation',[deviceId,expectedEpoch,expectedOwnerId]);
      if(row.rows.length!==1)denied('WITNESS_FREEZE_STALE');
    });
  }
}
