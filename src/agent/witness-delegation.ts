import * as z from 'zod';
import type {WitnessPgPool,WitnessPgConnection,VerifiedPrincipalResolver,
  IndependentProvenanceCheck,IndependentOperatorApproval,WitnessOperatorIntent}
  from './postgres-monotonic-witness.js';
import {WitnessAuthorityError} from './postgres-monotonic-witness.js';

const uuid=z.string().uuid();
const ROOT_MS=15*60*1000;
type Mode='NONE'|'CORE'|'ROOT';
type Action='bind_session'|'grant_core'|'grant_root'|'revoke'|'rotate_session'|'re_pair';
export interface DelegationChange {
  action:Action;
  deviceId:string;ownerId:string;deviceEpoch:string;sessionEpoch:string;
  expectedGeneration:number;signedProof:string;
  newSessionEpoch?:string;newOwnerId?:string;newDeviceEpoch?:string;
}
export interface DelegationStatus {
  mode:Mode;generation:number;corePersisted:boolean;
  rootExpiresAtMs:number|null;
}
export type VerifiedSessionResolver = (identity:{
  deviceId:string;ownerId:string;deviceEpoch:string;sessionEpoch:string;
})=>Promise<boolean>;
type Row={owner_id:unknown;epoch:unknown;session_epoch:unknown;
  generation:unknown;core_enabled:unknown;root_expires_ms:unknown;max_seen_ms:unknown};
type Device={owner_id:unknown;epoch:unknown;generation:unknown;state:unknown};
function deny(code:string):never{throw new WitnessAuthorityError(code)}
function integer(v:unknown,min=0):number{
  const value=typeof v==='string'?Number(v):v;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min)
    deny('DELEGATION_STORAGE_INVALID');
  return value as number;
}
function requireId(id:string):void{
  if(!uuid.safeParse(id).success)deny('DELEGATION_INVALID_ID');
}
function bool(v:unknown):boolean{
  if(v===true||v==='t')return true;
  if(v===false||v==='f')return false;
  deny('DELEGATION_STORAGE_INVALID');
}
function status(row:Row,now:number):DelegationStatus{
  const expires=row.root_expires_ms===null?null:integer(row.root_expires_ms);
  return {mode:expires!==null&&now<expires?'ROOT':
    bool(row.core_enabled)?'CORE':'NONE',
    generation:integer(row.generation,1),corePersisted:bool(row.core_enabled),
    rootExpiresAtMs:expires};
}
/**
 * Source-only authorization model. It does NOT install an elevated Windows
 * helper, impersonate a token, consent to UAC, or execute a mutation.
 * A caller must still bind these receipts to a separately protected broker.
 */
export class PostgresWitnessDelegation {
  constructor(private readonly config:{
    pool:WitnessPgPool;authorityId:string;
    verifyProvenance:IndependentProvenanceCheck;
    verifyOperatorApproval:IndependentOperatorApproval;
    resolvePrincipal:VerifiedPrincipalResolver;
    verifySession:VerifiedSessionResolver;
  }){requireId(config.authorityId)}

  private async proof():Promise<void>{
    let p;
    try{p=await this.config.verifyProvenance()}
    catch{deny('DELEGATION_PROVENANCE_UNAVAILABLE')}
    if(!p||p.verified!==true||p.authorityId!==this.config.authorityId||
       !Number.isFinite(p.validUntil)||p.validUntil<=Date.now())
      deny('DELEGATION_PROVENANCE_UNVERIFIED');
  }
  private async principal(input:{
    deviceId:string;ownerId:string;deviceEpoch:string;sessionEpoch:string;
  }):Promise<void>{
    let who,session=false;
    try{
      who=await this.config.resolvePrincipal(input.deviceId,input.deviceEpoch);
      session=await this.config.verifySession(input);
    }catch{deny('DELEGATION_IDENTITY_UNAVAILABLE')}
    if(!who||who.ownerId!==input.ownerId||
       who.deviceId!==input.deviceId||who.epoch!==input.deviceEpoch||
       session!==true)deny('DELEGATION_IDENTITY_UNVERIFIED');
  }
  private async signed(change:DelegationChange):Promise<void>{
    if(change.signedProof.length<32||change.signedProof.length>8192)
      deny('DELEGATION_OWNER_APPROVAL_REQUIRED');
    const intent:WitnessOperatorIntent={
      kind:change.action,authorityId:this.config.authorityId,
      deviceId:change.deviceId,ownerId:change.ownerId,epoch:change.deviceEpoch,
      sessionEpoch:change.sessionEpoch,generation:change.expectedGeneration,
      nextSessionEpoch:change.newSessionEpoch,nextOwnerId:change.newOwnerId,
      nextEpoch:change.newDeviceEpoch,
    };
    let approved=false;
    try{approved=await this.config.verifyOperatorApproval(intent,change.signedProof)}
    catch{deny('DELEGATION_OWNER_APPROVAL_UNVERIFIED')}
    if(approved!==true)deny('DELEGATION_OWNER_APPROVAL_UNVERIFIED');
  }
  private async transact<T>(fn:(db:WitnessPgConnection)=>Promise<T>):Promise<T>{
    let db:WitnessPgConnection;
    try{db=await this.config.pool.connect()}catch{
      deny('DELEGATION_STORAGE_UNAVAILABLE');
    }
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
  private async clock(db:WitnessPgConnection):Promise<number>{
    const result=await db.query(
      'SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS now_ms');
    return integer(result.rows[0]?.now_ms,1);
  }
  private async load(db:WitnessPgConnection,deviceId:string):
    Promise<{device:Device;row:Row|undefined}>{
    const device=(await db.query(
      'SELECT owner_id,epoch,generation,state FROM witness_devices '+
      'WHERE device_id=$1 FOR UPDATE',[deviceId])).rows[0] as Device|undefined;
    if(!device||device.state!=='active')deny('DELEGATION_DEVICE_NOT_ENROLLED');
    const row=(await db.query(
      'SELECT owner_id,epoch,session_epoch,generation,core_enabled,'+
      'root_expires_ms,max_seen_ms FROM witness_delegations '+
      'WHERE device_id=$1 FOR UPDATE',[deviceId])).rows[0] as Row|undefined;
    return {device:device!,row};
  }
  private assertCurrent(
    device:Device,row:Row|undefined,input:{
      ownerId:string;deviceEpoch:string;sessionEpoch:string;
    }):Row{
    if(device.owner_id!==input.ownerId||device.epoch!==input.deviceEpoch)
      deny('DELEGATION_OWNER_EPOCH_FENCED');
    if(!row||row.owner_id!==input.ownerId||
       row.epoch!==input.deviceEpoch||row.session_epoch!==input.sessionEpoch)
      deny('DELEGATION_SESSION_FENCED');
    return row;
  }
  /**
   * Read-only authorization is fail closed. This proof alone cannot elevate
   * any OS process. CORE persists across verified session rotation and Agent
   * restart; ROOT ends exactly at the externally anchored 15-minute expiry.
   */
  async evaluate(identity:{
    ownerId:string;deviceId:string;deviceEpoch:string;sessionEpoch:string;
  }):Promise<DelegationStatus>{
    for(const v of Object.values(identity))requireId(v);
    await this.proof();await this.principal(identity);
    return this.transact(async db=>{
      const now=await this.clock(db);
      const {device,row}=await this.load(db,identity.deviceId);
      const current=this.assertCurrent(device,row,identity);
      if(now<integer(current.max_seen_ms))
        deny('DELEGATION_SERVER_CLOCK_ROLLBACK');
      await db.query('UPDATE witness_delegations SET max_seen_ms=$2 '+
        'WHERE device_id=$1',[identity.deviceId,now]);
      return status(current,now);
    });
  }
  async change(change:DelegationChange):Promise<DelegationStatus>{
    for(const v of [change.deviceId,change.ownerId,change.deviceEpoch,
      change.sessionEpoch])requireId(v);
    if(change.newSessionEpoch)requireId(change.newSessionEpoch);
    if(change.newOwnerId)requireId(change.newOwnerId);
    if(change.newDeviceEpoch)requireId(change.newDeviceEpoch);
    if(!Number.isSafeInteger(change.expectedGeneration)||
       change.expectedGeneration<0)deny('DELEGATION_GENERATION_INVALID');
    if(change.action==='re_pair'&&(
      !change.newOwnerId||!change.newDeviceEpoch||
      change.newDeviceEpoch===change.deviceEpoch||!change.newSessionEpoch))
      deny('DELEGATION_REPAIR_INVALID');
    if(change.action==='re_pair'&&
       change.newSessionEpoch===change.sessionEpoch)
      deny('DELEGATION_SESSION_ROTATION_INVALID');
    if(change.action==='rotate_session'&&(
      !change.newSessionEpoch||change.newSessionEpoch===change.sessionEpoch))
      deny('DELEGATION_SESSION_ROTATION_INVALID');
    if(change.action!=='re_pair'&&change.action!=='rotate_session'&&
       (change.newOwnerId||change.newDeviceEpoch||change.newSessionEpoch))
      deny('DELEGATION_UNEXPECTED_SCOPE');
    await this.proof();
    await this.principal(change);
    await this.signed(change);
    return this.transact(async db=>{
      const now=await this.clock(db);
      const {device,row}=await this.load(db,change.deviceId);
      if(device.owner_id!==change.ownerId||device.epoch!==change.deviceEpoch)
        deny('DELEGATION_OWNER_EPOCH_FENCED');
      if(change.action==='bind_session'){
        if(row||change.expectedGeneration!==0)
          deny('DELEGATION_ALREADY_BOUND');
        await db.query('INSERT INTO witness_delegations '+
          '(device_id,owner_id,epoch,session_epoch,generation,core_enabled,'+
          'root_expires_ms,max_seen_ms) '+
          'VALUES($1,$2,$3,$4,1,FALSE,NULL,$5)',
          [change.deviceId,change.ownerId,change.deviceEpoch,
            change.sessionEpoch,now]);
        return {mode:'NONE',generation:1,corePersisted:false,rootExpiresAtMs:null};
      }
      const current=this.assertCurrent(device,row,change);
      if(integer(current.generation,1)!==change.expectedGeneration)
        deny('DELEGATION_STALE_GENERATION');
      if(now<integer(current.max_seen_ms))
        deny('DELEGATION_SERVER_CLOCK_ROLLBACK');
      if(change.action==='re_pair'){
        const deviceGeneration=integer(device.generation,1);
        const migration=await db.query(
          'UPDATE witness_devices SET owner_id=$2,epoch=$3,'+
          'generation=generation+1 WHERE device_id=$1 '+
          'AND owner_id=$4 AND epoch=$5 AND generation=$6 '+
          "AND state='active' RETURNING generation",
          [change.deviceId,change.newOwnerId,change.newDeviceEpoch,
            change.ownerId,change.deviceEpoch,deviceGeneration]);
        if(migration.rows.length!==1)deny('DELEGATION_REPAIR_RACE');
      }
      const newGeneration=change.expectedGeneration+1;
      const owner=change.action==='re_pair'?change.newOwnerId!:change.ownerId;
      const epoch=change.action==='re_pair'?change.newDeviceEpoch!:change.deviceEpoch;
      const session=change.action==='re_pair'||change.action==='rotate_session'
        ?change.newSessionEpoch!:change.sessionEpoch;
      const core=change.action==='grant_core'||change.action==='rotate_session'
        ?bool(current.core_enabled):
        change.action==='grant_root'?bool(current.core_enabled):false;
      const keepCore=change.action==='grant_core'?true:core;
      const expires=change.action==='grant_root'?now+ROOT_MS:null;
      const changed=await db.query('UPDATE witness_delegations '+
        'SET owner_id=$2,epoch=$3,session_epoch=$4,generation=$5,'+
        'core_enabled=$6,root_expires_ms=$7,max_seen_ms=$8 '+
        'WHERE device_id=$1 AND generation=$9 RETURNING generation',
        [change.deviceId,owner,epoch,session,newGeneration,
          keepCore,expires,now,change.expectedGeneration]);
      if(changed.rows.length!==1)deny('DELEGATION_CONCURRENT_CHANGE');
      return {mode:expires!==null?'ROOT':keepCore?'CORE':'NONE',
        generation:newGeneration,corePersisted:keepCore,
        rootExpiresAtMs:expires};
    });
  }
}
