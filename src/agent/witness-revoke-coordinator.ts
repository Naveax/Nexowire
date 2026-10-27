import type {DelegationChange,DelegationStatus}
  from './witness-delegation.js';
import type {ExternalGrantCas,ExternalRevokeReceipt,ExternalRePairReceipt}
  from './postgres-bound-grant-cas.js';
import type {IndependentOperatorApproval,VerifiedPrincipalResolver,
  WitnessPgPool,WitnessPgConnection,WitnessOperatorIntent}
  from './postgres-monotonic-witness.js';
import {WitnessAuthorityError} from './postgres-monotonic-witness.js';

export class RevokeOutcomeUnknown extends Error {
  constructor(readonly code:string){
    super('Remote transition may have committed: no replay, owner reconciliation required.');
    this.name='RevokeOutcomeUnknown';
  }
}
const deny=(code:string):never=>{throw new WitnessAuthorityError(code)};
function number(v:unknown,min=1):number{
  const n=typeof v==='string'?Number(v):v;
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<min)
    deny('RECONCILE_INVALID_STORAGE');
  return n as number;
}
type Transition='revoke'|'re_pair';
type Receipt=ExternalRevokeReceipt|ExternalRePairReceipt;
/** Pin every transition field before the first asynchronous authorization. */
function snapshotChange(change:DelegationChange):DelegationChange{
  if(!change||typeof change!=='object')deny('TRANSITION_INVALID');
  const copy:DelegationChange={
    action:change.action,deviceId:change.deviceId,ownerId:change.ownerId,
    deviceEpoch:change.deviceEpoch,sessionEpoch:change.sessionEpoch,
    expectedGeneration:change.expectedGeneration,signedProof:change.signedProof,
    newOwnerId:change.newOwnerId,newDeviceEpoch:change.newDeviceEpoch,
    newSessionEpoch:change.newSessionEpoch,
  };
  Object.freeze(copy);
  return copy;
}
/**
 * Remote-first grant transition. A signed owner approval is verified before
 * the remote external CAS. Local PostgreSQL only materializes an already
 * externally committed transition using an exact scoped, monotonic receipt.
 *
 * This deliberately does not reauthenticate the OLD owner after remote
 * re-pair: the external authority may have already revoked that identity.
 * The receipt, earlier verified operator signature and conditional old
 * generation are the only allowed reconciliation evidence.
 */
export class WitnessRevokeCoordinator {
  constructor(private readonly config:{
    external:ExternalGrantCas;
    pool:WitnessPgPool;
    authorityId:string;
    verifyOperatorApproval:IndependentOperatorApproval;
    verifyPrincipal:VerifiedPrincipalResolver;
    verifySession:(arg:{deviceId:string;ownerId:string;
      deviceEpoch:string;sessionEpoch:string})=>Promise<boolean>;
  }){}

  private async authorize(change:DelegationChange,kind:Transition):Promise<void>{
    if(change.action!==kind||!Number.isSafeInteger(change.expectedGeneration)||
       change.expectedGeneration<1||!change.signedProof||
       change.signedProof.length<32||change.signedProof.length>8192)
      deny('TRANSITION_INVALID');
    if(kind==='revoke'&&(change.newOwnerId||
      change.newDeviceEpoch||change.newSessionEpoch))
      deny('REVOKE_UNEXPECTED_SCOPE');
    if(kind==='re_pair'&&(!change.newOwnerId||!change.newDeviceEpoch||
      !change.newSessionEpoch||
      change.newDeviceEpoch===change.deviceEpoch||
      change.newSessionEpoch===change.sessionEpoch))
      deny('REPAIR_INVALID_SCOPE');
    const principal=await this.config.verifyPrincipal(
      change.deviceId,change.deviceEpoch).catch(()=>
      deny('TRANSITION_OWNER_UNAVAILABLE'));
    if(!principal||principal.ownerId!==change.ownerId||
       principal.deviceId!==change.deviceId||
       principal.epoch!==change.deviceEpoch)
      deny('TRANSITION_OWNER_MISMATCH');
    const session=await this.config.verifySession({
      ownerId:change.ownerId,deviceId:change.deviceId,
      deviceEpoch:change.deviceEpoch,sessionEpoch:change.sessionEpoch,
    }).catch(()=>false);
    if(!session)deny('TRANSITION_SESSION_STALE');
    const intent:WitnessOperatorIntent={
      kind,authorityId:this.config.authorityId,deviceId:change.deviceId,
      ownerId:change.ownerId,epoch:change.deviceEpoch,
      sessionEpoch:change.sessionEpoch,generation:change.expectedGeneration,
      ...(kind==='re_pair'?{
        nextOwnerId:change.newOwnerId,nextEpoch:change.newDeviceEpoch,
        nextSessionEpoch:change.newSessionEpoch,
      }:{}),
    };
    const authorized=await this.config.verifyOperatorApproval(
      intent,change.signedProof).catch(()=>false);
    if(!authorized)deny('TRANSITION_SIGNATURE_UNTRUSTED');
  }
  private verifyReceipt(
    change:DelegationChange,receipt:Receipt,kind:Transition):void{
    if(!receipt||receipt.authorityId!==this.config.authorityId||
       receipt.deviceId!==change.deviceId||
       receipt.ownerId!==change.ownerId||
       receipt.deviceEpoch!==change.deviceEpoch||
       receipt.sessionEpoch!==change.sessionEpoch||
       receipt.revoked!==true||
       receipt.previousGeneration!==change.expectedGeneration||
       receipt.generation!==change.expectedGeneration+1)
      deny('TRANSITION_EXTERNAL_PROOF_MISMATCH');
    if(kind==='re_pair'){
      const repair=receipt as ExternalRePairReceipt;
      if(repair.newOwnerId!==change.newOwnerId||
         repair.newDeviceEpoch!==change.newDeviceEpoch||
         repair.newSessionEpoch!==change.newSessionEpoch||
         repair.coreCleared!==true)
        deny('REPAIR_EXTERNAL_PROOF_MISMATCH');
    }
  }
  private async applyConfirmed(
    change:DelegationChange,receipt:Receipt,kind:Transition,
  ):Promise<DelegationStatus>{
    let db:WitnessPgConnection;
    try{db=await this.config.pool.connect()}
    catch{throw new RevokeOutcomeUnknown('TRANSITION_LOCAL_DB_UNAVAILABLE')}
    let active=false;
    try{
      await db.query('BEGIN');active=true;
      const devices=await db.query(
        'SELECT owner_id,epoch,generation,state FROM witness_devices '+
        'WHERE device_id=$1 FOR UPDATE',[change.deviceId]);
      const dev=devices.rows[0];
      if(!dev)return deny('TRANSITION_DEVICE_STATE_CONFLICT');
      if(dev.state!=='active'||dev.owner_id!==change.ownerId||
         dev.epoch!==change.deviceEpoch)
        deny('TRANSITION_DEVICE_STATE_CONFLICT');
      const delegated=await db.query(
        'SELECT owner_id,epoch,session_epoch,generation,core_enabled,'+
        'root_expires_ms,max_seen_ms FROM witness_delegations '+
        'WHERE device_id=$1 FOR UPDATE',[change.deviceId]);
      const row=delegated.rows[0];
      if(!row)return deny('TRANSITION_LOCAL_GENERATION_CONFLICT');
      if(row.owner_id!==change.ownerId||
         row.epoch!==change.deviceEpoch||
         row.session_epoch!==change.sessionEpoch||
         number(row.generation)!==change.expectedGeneration)
        deny('TRANSITION_LOCAL_GENERATION_CONFLICT');
      const time=await db.query(
        'SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS now_ms');
      const now=number(time.rows[0]?.now_ms);
      if(now<number(row.max_seen_ms,0))deny('TRANSITION_CLOCK_REWIND');
      if(kind==='re_pair'){
        const deviceUpdate=await db.query(
          'UPDATE witness_devices SET owner_id=$2,epoch=$3,'+
          'generation=generation+1 WHERE device_id=$1 AND owner_id=$4 '+
          "AND epoch=$5 AND generation=$6 AND state='active' "+
          'RETURNING generation',
          [change.deviceId,change.newOwnerId,change.newDeviceEpoch,
            change.ownerId,change.deviceEpoch,number(dev.generation)]);
        if(deviceUpdate.rows.length!==1)deny('TRANSITION_DEVICE_CAS_LOST');
      }
      const result=await db.query(
        'UPDATE witness_delegations '+
        'SET owner_id=$2,epoch=$3,session_epoch=$4,generation=$5,'+
        'core_enabled=$6,root_expires_ms=$7,max_seen_ms=$8 '+
        'WHERE device_id=$1 AND generation=$9 RETURNING generation',
        [change.deviceId,kind==='re_pair'?change.newOwnerId:change.ownerId,
          kind==='re_pair'?change.newDeviceEpoch:change.deviceEpoch,
          kind==='re_pair'?change.newSessionEpoch:change.sessionEpoch,
          receipt.generation,false,null,now,change.expectedGeneration]);
      if(result.rows.length!==1||
         number(result.rows[0]?.generation)!==receipt.generation)
        deny('TRANSITION_LOCAL_CAS_LOST');
      await db.query('COMMIT');active=false;
      return {mode:'NONE',generation:receipt.generation,
        corePersisted:false,rootExpiresAtMs:null};
    }catch{
      if(active){try{await db.query('ROLLBACK')}catch{}}
      throw new RevokeOutcomeUnknown('TRANSITION_LOCAL_RECONCILIATION_REQUIRED');
    }finally{db.release()}
  }
  async revoke(change:DelegationChange):Promise<{
    external:ExternalRevokeReceipt;local:DelegationStatus;
  }>{
    const request=snapshotChange(change);
    await this.authorize(request,'revoke');
    let receipt:ExternalRevokeReceipt;
    try{
      const confirmed=await this.config.external.revokeIfCurrent({
        deviceId:request.deviceId,ownerId:request.ownerId,
        deviceEpoch:request.deviceEpoch,sessionEpoch:request.sessionEpoch,
        expectedGeneration:request.expectedGeneration,
        signedOwnerApproval:request.signedProof,
      });
      receipt={...confirmed};
      Object.freeze(receipt);
    }catch{throw new RevokeOutcomeUnknown('REVOKE_EXTERNAL_OUTCOME_UNKNOWN')}
    this.verifyReceipt(request,receipt,'revoke');
    const local=await this.applyConfirmed(request,receipt,'revoke');
    return {external:receipt,local};
  }
  async rePair(change:DelegationChange):Promise<{
    external:ExternalRePairReceipt;local:DelegationStatus;
  }>{
    const request=snapshotChange(change);
    await this.authorize(request,'re_pair');
    let receipt:ExternalRePairReceipt;
    try{
      const confirmed=await this.config.external.rePairIfCurrent({
        deviceId:request.deviceId,ownerId:request.ownerId,
        deviceEpoch:request.deviceEpoch,sessionEpoch:request.sessionEpoch,
        expectedGeneration:request.expectedGeneration,
        signedOwnerApproval:request.signedProof,
        newOwnerId:request.newOwnerId!,newDeviceEpoch:request.newDeviceEpoch!,
        newSessionEpoch:request.newSessionEpoch!,
      });
      receipt={...confirmed};
      Object.freeze(receipt);
    }catch{throw new RevokeOutcomeUnknown('REPAIR_EXTERNAL_OUTCOME_UNKNOWN')}
    this.verifyReceipt(request,receipt,'re_pair');
    const local=await this.applyConfirmed(request,receipt,'re_pair');
    return {external:receipt,local};
  }
}
