import * as z from 'zod';
import {types as nodeTypes} from 'node:util';
import type {CasRequest,CasReservation,MonotonicTrustRoot}
  from './remote-mutation-cas.js';
import type {WitnessPgConnection,WitnessPgPool,
  IndependentProvenanceCheck} from './postgres-monotonic-witness.js';
import {WitnessAuthorityError} from './postgres-monotonic-witness.js';

const uuid=z.string().uuid();
const request=z.object({
  deviceId:uuid,epoch:uuid,requestId:uuid,
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
  capability:z.string().min(1).max(128),
}).strict();
/**
 * Snapshot the original CAS request without invoking caller-owned getters.
 * Zod's standard object parse can read accessors; an accessor may change the
 * UUID/fingerprint or create side effects before the first identity check.
 * This does not authenticate the request: external CAS remains authoritative.
 */
function immutableRequest(candidate:unknown):Readonly<CasRequest>{
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate)||
     nodeTypes.isProxy(candidate))
    reject('BOUND_CAS_REQUEST_INVALID');
  const inspected=candidate as object;
  let descriptors:PropertyDescriptorMap;
  let keys:PropertyKey[];
  let prototype:unknown;
  try{
    descriptors=Object.getOwnPropertyDescriptors(inspected);
    keys=Reflect.ownKeys(inspected);
    prototype=Object.getPrototypeOf(inspected);
  }catch{return reject('BOUND_CAS_REQUEST_INVALID')}
  const required=['deviceId','epoch','requestId','fingerprint',
    'capability'] as const;
  if((prototype!==Object.prototype&&prototype!==null)||
     keys.length!==required.length||
     required.some(key=>!Object.prototype.hasOwnProperty.call(descriptors,key)||
       !('value' in descriptors[key]!)||
       descriptors[key]!.enumerable!==true))
    reject('BOUND_CAS_REQUEST_INVALID');
  const detached=Object.fromEntries(
    required.map(key=>[key,descriptors[key]!.value]),
  );
  const parsed=request.safeParse(detached);
  if(!parsed.success)return reject('BOUND_CAS_REQUEST_INVALID');
  return Object.freeze(parsed.data);
}

const externalReceiptSchema=z.object({
  authorityId:uuid,deviceId:uuid,epoch:uuid,requestId:uuid,
  ownerId:uuid,sessionEpoch:uuid,
  grantGeneration:z.number().int().positive().safe(),
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
  capability:z.string().min(1).max(128),
  created:z.boolean(),sequence:z.number().int().positive().safe(),
}).strict();
export type RequiredPrivilege='NORMAL'|'CORE'|'ROOT';
/**
 * A protected identity provider MUST derive this from the authenticated
 * device/session credential, not from request body, UI or restored SQLite.
 * A previously signed owner grant alone is insufficient.
 */
export interface AuthenticatedGrantScope {
  ownerId:string;
  deviceId:string;
  deviceEpoch:string;
  sessionEpoch:string;
  expectedGeneration:number;
  requiredPrivilege:RequiredPrivilege;
}
/**
 * Atomic conditional-create receipt issued by the ACTUAL independent CAS
 * service. Read-only status from a stale signed grant is not sufficient.
 */
export interface ExternalGrantCasReceipt extends CasReservation {
  ownerId:string;
  sessionEpoch:string;
  grantGeneration:number;
  fingerprint:string;
  capability:string;
}
export interface ExternalRevokeRequest {
  deviceId:string;
  ownerId:string;
  deviceEpoch:string;
  sessionEpoch:string;
  expectedGeneration:number;
  /** Server MUST independently validate this signed operator approval. */
  signedOwnerApproval:string;
}
export interface ExternalRevokeReceipt {
  authorityId:string;deviceId:string;ownerId:string;
  deviceEpoch:string;sessionEpoch:string;
  previousGeneration:number;generation:number;
  revoked:true;
}
export interface ExternalRePairRequest extends ExternalRevokeRequest {
  newOwnerId:string;
  newDeviceEpoch:string;
  newSessionEpoch:string;
}
export interface ExternalRePairReceipt extends ExternalRevokeReceipt {
  newOwnerId:string;
  newDeviceEpoch:string;
  newSessionEpoch:string;
  coreCleared:true;
}
export interface ExternalGrantCas {
  revokeIfCurrent(request:ExternalRevokeRequest):Promise<ExternalRevokeReceipt>;
  rePairIfCurrent(request:ExternalRePairRequest):Promise<ExternalRePairReceipt>;
  /**
   * The separately operated service MUST atomically check active
   * owner/device/session/generation/revoke fence AND reserve the global UUID.
   * A lookup-then-insert, in-memory Map, or local SQLite is not acceptable.
   */
  reserveIfCurrent(request:CasRequest,
    scope:AuthenticatedGrantScope):Promise<ExternalGrantCasReceipt>;
}
/**
 * Production requires verified independent durable custody and actual
 * remote CAS semantics. An interface/mock does NOT attest such a deployment.
 */

type Enrolled={owner_id:unknown;epoch:unknown;generation:unknown;state:unknown};
type Delegated={
  owner_id:unknown;epoch:unknown;session_epoch:unknown;
  generation:unknown;core_enabled:unknown;root_expires_ms:unknown;
  max_seen_ms:unknown;
};
type Stored={sequence:unknown;device_id:unknown;owner_id:unknown;
  epoch:unknown;fingerprint:unknown;capability:unknown};
const reject=(code:string):never=>{throw new WitnessAuthorityError(code)};
function integer(v:unknown,min=0):number{
  const n=typeof v==='string'?Number(v):v;
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<min)
    reject('BOUND_CAS_STORAGE_INVALID');
  return n as number;
}
function boolean(v:unknown):boolean{
  if(v===true||v==='t')return true;
  if(v===false||v==='f')return false;
  return reject('BOUND_CAS_STORAGE_INVALID');
}
function validScope(scope:AuthenticatedGrantScope,requested:CasRequest):void{
  if(!uuid.safeParse(scope.ownerId).success||
     !uuid.safeParse(scope.deviceId).success||
     !uuid.safeParse(scope.deviceEpoch).success||
     !uuid.safeParse(scope.sessionEpoch).success||
     !Number.isSafeInteger(scope.expectedGeneration)||
     scope.expectedGeneration<1||
     !(['NORMAL','CORE','ROOT'] as const).includes(scope.requiredPrivilege))
    reject('BOUND_CAS_UNVERIFIED_SCOPE');
  if(scope.deviceId!==requested.deviceId||
     scope.deviceEpoch!==requested.epoch)
    reject('BOUND_CAS_REQUEST_SCOPE_MISMATCH');
}
/**
 * Detach a resolver-owned identity before the first asynchronous database
 * boundary. Checking a borrowed object and then awaiting FOR UPDATE used to
 * permit the resolver to change owner/session/generation before the external
 * reserve and local tombstone insert. Descriptor inspection also refuses
 * accessor-backed fields without invoking a hostile getter.
 *
 * This freezes metadata, not authorization: the external provider must still
 * atomically verify the CURRENT owner/revoke fence with the original UUID.
 */
function immutableScope(
  candidate:unknown,requested:CasRequest,
):Readonly<AuthenticatedGrantScope>{
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate)||
     nodeTypes.isProxy(candidate))
    reject('BOUND_CAS_UNVERIFIED_SCOPE');
  // The preceding runtime guard guarantees an object; keep that narrowing
  // explicit for Reflect.ownKeys across the TypeScript compiler matrix.
  const inspected=candidate as object;
  let descriptors:PropertyDescriptorMap;
  let keys:PropertyKey[];
  let prototype:unknown;
  try{
    descriptors=Object.getOwnPropertyDescriptors(inspected);
    keys=Reflect.ownKeys(inspected);
    prototype=Object.getPrototypeOf(inspected);
  }catch{return reject('BOUND_CAS_UNVERIFIED_SCOPE')}
  const required=['ownerId','deviceId','deviceEpoch','sessionEpoch',
    'expectedGeneration','requiredPrivilege'] as const;
  if((prototype!==Object.prototype&&prototype!==null)||
     keys.length!==required.length||
     required.some(key=>!Object.prototype.hasOwnProperty.call(descriptors,key)||
       !('value' in descriptors[key]!)||
       descriptors[key]!.enumerable!==true))
    reject('BOUND_CAS_UNVERIFIED_SCOPE');
  const snapshot=Object.freeze({
    ownerId:descriptors.ownerId!.value as string,
    deviceId:descriptors.deviceId!.value as string,
    deviceEpoch:descriptors.deviceEpoch!.value as string,
    sessionEpoch:descriptors.sessionEpoch!.value as string,
    expectedGeneration:descriptors.expectedGeneration!.value as number,
    requiredPrivilege:descriptors.requiredPrivilege!.value as RequiredPrivilege,
  });
  validScope(snapshot,requested);
  return snapshot;
}

/**
 * External CAS returns an untrusted, potentially borrowed object. Never keep
 * its created/sequence/identity fields across the next awaited SQL query:
 * an adapter with a retained reference could flip created:false to true and
 * turn a replayed request into a fresh local insert. Copy only own data
 * descriptors; do not invoke a provider-supplied getter.
 */
function immutableExternalReceipt(
  value:unknown,
):Readonly<ExternalGrantCasReceipt>{
  if(!value||typeof value!=='object'||Array.isArray(value)||
     nodeTypes.isProxy(value))
    reject('BOUND_CAS_EXTERNAL_PROOF_MISMATCH');
  const inspected=value as object;
  let descriptors:PropertyDescriptorMap;
  let keys:PropertyKey[];
  let prototype:unknown;
  try{
    descriptors=Object.getOwnPropertyDescriptors(inspected);
    keys=Reflect.ownKeys(inspected);
    prototype=Object.getPrototypeOf(inspected);
  }catch{return reject('BOUND_CAS_EXTERNAL_PROOF_MISMATCH')}
  const required=['authorityId','deviceId','epoch','requestId','ownerId',
    'sessionEpoch','grantGeneration','fingerprint','capability','created',
    'sequence'] as const;
  if((prototype!==Object.prototype&&prototype!==null)||
     keys.length!==required.length||
     required.some(key=>!Object.prototype.hasOwnProperty.call(descriptors,key)||
       !('value' in descriptors[key]!)||
       descriptors[key]!.enumerable!==true))
    reject('BOUND_CAS_EXTERNAL_PROOF_MISMATCH');
  const detached=Object.fromEntries(
    required.map(key=>[key,descriptors[key]!.value]),
  );
  const parsed=externalReceiptSchema.safeParse(detached);
  if(!parsed.success)return reject('BOUND_CAS_EXTERNAL_PROOF_MISMATCH');
  const accepted=parsed.data;
  if(!accepted)return reject('BOUND_CAS_EXTERNAL_PROOF_MISMATCH');
  return Object.freeze(accepted);
}


/** Select only own enumerable data fields before binding CAS providers.
 * A borrowed config's accessor must never execute during constructor setup.
 */
function immutablePgConfig<T extends object>(raw:T):Readonly<T>{
  const invalid=()=>reject('BOUND_CAS_AUTHORITY_INVALID');
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||nodeTypes.isProxy(raw))
    return invalid();
  let descriptors:PropertyDescriptorMap;
  let keys:PropertyKey[];
  let proto:unknown;
  try{
    descriptors=Object.getOwnPropertyDescriptors(raw);
    keys=Reflect.ownKeys(raw);
    proto=Object.getPrototypeOf(raw);
  }catch{return invalid()}
  const required=['pool','authorityId','verifyProvenance',
    'resolveAuthenticatedScope','externalCas'];
  if((proto!==Object.prototype&&proto!==null)||
     keys.length!==required.length||
     required.some(key=>!keys.includes(key))||
     keys.some(key=>typeof key!=='string'||
       !Object.prototype.hasOwnProperty.call(descriptors,key)||
       !('value' in descriptors[key]!)||
       descriptors[key]!.enumerable!==true))
    return invalid();
  return Object.freeze(Object.fromEntries((keys as string[]).map(
    key=>[key,descriptors[key]!.value]))) as Readonly<T>;
}

/**
 * Real PostgreSQL source integration for a remote witness CAS.
 *
 * The device row AND delegation row are locked in the SAME transaction as
 * the global request-ID tombstone and monotonically increasing clock. Thus
 * revoke/re-pair and reserve serialize on the device row: a stale signed
 * grant cannot pass between authorization check and reservation COMMIT.
 *
 * Still NOT physically proven: PostgreSQL itself might be restored. An
 * independently protected grant-fence readback is mandatory, and production
 * remains NO-GO until that controller and PG hosting are attested/tested.
 */
export class PostgresBoundGrantCas implements MonotonicTrustRoot {
  constructor(private readonly config:{
    pool:WitnessPgPool;
    authorityId:string;
    verifyProvenance:IndependentProvenanceCheck;
    /**
     * Protected credential resolution, not caller-supplied owner/session.
     * This must not simply trust the owner fields of a prior signed grant.
     */
    resolveAuthenticatedScope:(request:CasRequest)=>
      Promise<AuthenticatedGrantScope|undefined>;
    externalCas:ExternalGrantCas;
  }){
    // Pin independently selected authority, pool, identity resolver and CAS
    // implementation before any async provenance or SQL boundary.
    const pinned=immutablePgConfig(config);
    if(!uuid.safeParse(pinned.authorityId).success||
       typeof pinned.verifyProvenance!=='function'||
       typeof pinned.resolveAuthenticatedScope!=='function')
      reject('BOUND_CAS_AUTHORITY_INVALID');
    if(!pinned.pool||!pinned.externalCas)

      reject('BOUND_CAS_AUTHORITY_INVALID');
    this.config=pinned;
    Object.defineProperty(this,'config',{writable:false,configurable:false});
  }
  private async trusted():Promise<void>{
    let p;
    try{p=await this.config.verifyProvenance()}
    catch{reject('BOUND_CAS_PROVENANCE_UNAVAILABLE')}
    if(!p||p.verified!==true||p.authorityId!==this.config.authorityId||
       !Number.isFinite(p.validUntil)||p.validUntil<=Date.now())
      reject('BOUND_CAS_PROVENANCE_UNVERIFIED');
  }
  private async authenticate(input:CasRequest):Promise<AuthenticatedGrantScope>{
    let scope;
    try{scope=await this.config.resolveAuthenticatedScope(input)}
    catch{reject('BOUND_CAS_AUTHENTICATION_UNAVAILABLE')}
    if(!scope)reject('BOUND_CAS_AUTHENTICATION_MISSING');
    return immutableScope(scope,input);
  }
  private async reserveExternally(input:CasRequest,
    scope:AuthenticatedGrantScope):Promise<ExternalGrantCasReceipt>{
    let proof:ExternalGrantCasReceipt;
    try{proof=await this.config.externalCas.reserveIfCurrent(input,scope)}
    catch{return reject('BOUND_CAS_EXTERNAL_RESERVATION_UNKNOWN')}
    // Detached before the next awaited PostgreSQL read. Never let a
    // provider mutate a validated created:false into a fresh reservation.
    const immutable=immutableExternalReceipt(proof);
    if(!immutable||immutable.authorityId!==this.config.authorityId||
       immutable.deviceId!==input.deviceId||immutable.epoch!==input.epoch||
       immutable.requestId!==input.requestId||
       immutable.ownerId!==scope.ownerId||
       immutable.sessionEpoch!==scope.sessionEpoch||
       immutable.grantGeneration!==scope.expectedGeneration||
       immutable.fingerprint!==input.fingerprint||
       immutable.capability!==input.capability)
      reject('BOUND_CAS_EXTERNAL_PROOF_MISMATCH');
    return immutable;
  }
  private async transaction<T>(fn:(db:WitnessPgConnection)=>Promise<T>):Promise<T>{
    let db:WitnessPgConnection;
    try{db=await this.config.pool.connect()}
    catch{return reject('BOUND_CAS_PG_UNAVAILABLE')}
    let started=false;
    try{
      await db.query('BEGIN');started=true;
      const result=await fn(db);
      await db.query('COMMIT');started=false;
      return result;
    }catch(e){
      if(started){try{await db.query('ROLLBACK')}catch{}}
      throw e;
    }finally{db.release()}
  }
  async reserve(value:CasRequest):Promise<CasReservation>{
    // The callback receives the same immutable UUID/fingerprint/scope key
    // even if it keeps a reference across credential or SQL awaits.
    const input=immutableRequest(value);
    await this.trusted();
    const scope=await this.authenticate(input);
    return this.transaction(async db=>{
      // Retains a row lock while validating external current owner/epoch
      // and while reserving. Any competing revoke or re-pair blocks here.
      const device=(await db.query(
        'SELECT owner_id,epoch,generation,state FROM witness_devices '+
        'WHERE device_id=$1 FOR UPDATE',[input.deviceId])).rows[0] as
        Enrolled|undefined;
      if(!device||device.state!=='active'||device.owner_id!==scope.ownerId||
         device.epoch!==scope.deviceEpoch)
        reject('BOUND_CAS_DEVICE_REVOKED');
      const grant=(await db.query(
        'SELECT owner_id,epoch,session_epoch,generation,core_enabled,'+
        'root_expires_ms,max_seen_ms FROM witness_delegations '+
        'WHERE device_id=$1 FOR UPDATE',[input.deviceId])).rows[0] as
        Delegated|undefined;
      if(!grant)return reject('BOUND_CAS_STALE_GRANT');
      if(grant.owner_id!==scope.ownerId||
         grant.epoch!==scope.deviceEpoch||
         grant.session_epoch!==scope.sessionEpoch||
         integer(grant.generation,1)!==scope.expectedGeneration)
        reject('BOUND_CAS_STALE_GRANT');
      const nowRow=(await db.query(
        'SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS now_ms'))
        .rows[0] as {now_ms:unknown}|undefined;
      const now=integer(nowRow?.now_ms,1);
      if(now<integer(grant.max_seen_ms))
        reject('BOUND_CAS_WITNESS_CLOCK_REWIND');
      if(scope.requiredPrivilege==='CORE'&&!boolean(grant.core_enabled))
        reject('BOUND_CAS_CORE_REVOKED');
      if(scope.requiredPrivilege==='ROOT'&&(
        grant.root_expires_ms===null||
        now>=integer(grant.root_expires_ms)))
        reject('BOUND_CAS_ROOT_EXPIRED');
      // Atomic external CAS, not just a potentially stale readback. The
      // external service must serialize reserve with owner revoke/re-pair.
      const external=await this.reserveExternally(input,scope);
      const previous=(await db.query(
        'SELECT sequence,device_id,owner_id,epoch,fingerprint,capability '+
        'FROM witness_reservations WHERE request_id=$1',[input.requestId]))
        .rows[0] as Stored|undefined;
      if(previous){
        if(previous.device_id!==input.deviceId||
           previous.owner_id!==scope.ownerId||
           previous.epoch!==scope.deviceEpoch||
           previous.fingerprint!==input.fingerprint||
           previous.capability!==input.capability||
           external.created)
          reject('BOUND_CAS_REQUEST_ID_COLLISION');
        return {authorityId:this.config.authorityId,
          deviceId:input.deviceId,epoch:input.epoch,requestId:input.requestId,
          sequence:external.sequence,created:false};
      }
      // External receipt is authoritative even if this local PostgreSQL
      // cache has been restored and has forgotten the request UUID.
      if(!external.created)return {...external,created:false};
      const clock=(await db.query(
        'UPDATE witness_clock SET last_sequence=last_sequence+1 '+
        'WHERE id=1 RETURNING last_sequence')).rows[0] as
        {last_sequence:unknown}|undefined;
      if(!clock)return reject('BOUND_CAS_CLOCK_MISSING');
      const sequence=integer(clock.last_sequence,1);
      const inserted=(await db.query(
        'INSERT INTO witness_reservations '+
        '(sequence,request_id,device_id,owner_id,epoch,fingerprint,capability) '+
        'VALUES($1,$2,$3,$4,$5,$6,$7) '+
        'ON CONFLICT (request_id) DO NOTHING RETURNING sequence',
        [sequence,input.requestId,input.deviceId,scope.ownerId,
          input.epoch,input.fingerprint,input.capability]))
        .rows[0] as {sequence:unknown}|undefined;
      if(!inserted||integer(inserted.sequence,1)!==sequence)
        reject('BOUND_CAS_CONCURRENT_ID_CONFLICT');
      await db.query('UPDATE witness_delegations SET max_seen_ms=$2 '+
        'WHERE device_id=$1',[input.deviceId,now]);
      return {authorityId:this.config.authorityId,deviceId:input.deviceId,
        epoch:input.epoch,requestId:input.requestId,
        sequence:external.sequence,created:true};
    });
  }
}
