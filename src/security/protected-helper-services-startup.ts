import * as z from 'zod';
import type {DispatchStorePool,DispatchStoreConnection} from '../agent/postgres-broker-dispatch-authority.js';
import type {DispatchRevokeRequest} from '../agent/broker-external-dispatch-fence.js';
import {createSignedHelperSelectionEvidenceVerifier,type SignedHelperEvidenceConfig} from './signed-helper-selection-evidence.js';
import type {HelperAuthorityScope,HelperLease} from './postgres-helper-selection-authority.js';
import type {HelperSelection} from '../installer/protected-transfer-helper-lifecycle.js';

const uuid=z.string().uuid(),hex=z.string().length(64).regex(/^[a-f0-9]{64}$/);
const scopeSchema=z.strictObject({authorityId:uuid,deviceId:uuid,ownerId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  ownerEpoch:z.number().int().positive().safe(),generation:z.number().int().positive().safe(),brokerId:uuid});
const number=(v:unknown)=>typeof v==='string'&&/^[0-9]+$/.test(v)?Number(v):v;
function exactSelectionIdentity(row:Record<string,unknown>|undefined,s:HelperAuthorityScope){
  return !!row&&row.owner_id===s.ownerId&&row.device_epoch===s.deviceEpoch&&row.session_epoch===s.sessionEpoch&&
    number(row.owner_epoch)===s.ownerEpoch&&number(row.generation)===s.generation&&row.broker_id===s.brokerId;
}
function selected(row:Record<string,unknown>):HelperSelection{
  const value=z.strictObject({revision:uuid,pin:z.strictObject({sha256:hex,signerSha256:hex}).nullable()}).parse({
    revision:row.revision,pin:row.sha256===null&&row.signer_sha256===null?null:{sha256:row.sha256,signerSha256:row.signer_sha256}});
  if(value.pin)Object.freeze(value.pin);return Object.freeze(value);
}
function lease(row:Record<string,unknown>,current:HelperSelection):HelperLease{
  const value=z.strictObject({id:uuid,requestId:uuid,kind:z.enum(['RUNTIME','DEPLOYMENT']),expectedRevision:uuid}).parse({
    id:row.id,requestId:row.request_id,kind:row.kind,expectedRevision:row.expected_revision});
  if((row.state!=='ACTIVE'&&row.state!=='COMMITTED')||current.revision!==(row.committed_revision??row.expected_revision)||
     (row.state==='COMMITTED'&&(value.kind!=='DEPLOYMENT'||!uuid.safeParse(row.committed_revision).success))||
     (row.state==='ACTIVE'&&row.committed_revision!==null))throw Error('HELPER_DRAIN_LEASE_INVALID');
  return Object.freeze(value);
}
async function bounded<T>(effect:()=>Promise<T>,ms:number){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([effect(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('HELPER_DRAIN_TIMEOUT')),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}
/** Read-only observer for the existing CORE revoke transaction hook ONLY.
 * Caller already holds core_dispatch.authorities lock; never acquire it again.
 * The grant is REVOKING, so all old runtime read/commit/acquire paths are
 * fenced. Keep unreleased lease history even after independently proven drain.
 * A separate operator recovery procedure is needed to reconcile/re-pair. */
export function composeHelperSelectionRevokeDrain(config:{
  pool:DispatchStorePool;scope:HelperAuthorityScope;nativeEvidence:SignedHelperEvidenceConfig;
  verifyExistingNativeDrain:(request:DispatchRevokeRequest)=>Promise<boolean>;
}){
  const scope=Object.freeze(scopeSchema.parse(config.scope));
  const verify=createSignedHelperSelectionEvidenceVerifier(config.nativeEvidence);
  if(typeof config.pool?.connect!=='function'||typeof config.verifyExistingNativeDrain!=='function')throw Error('HELPER_DRAIN_CONFIG_INVALID');
  const pool=config.pool,existing=config.verifyExistingNativeDrain;
  return async(req:DispatchRevokeRequest):Promise<boolean>=>{
    if(!uuid.safeParse(req?.deviceId).success||!uuid.safeParse(req?.ownerId).success||
       !uuid.safeParse(req?.deviceEpoch).success||!uuid.safeParse(req?.sessionEpoch).success||
       !Number.isSafeInteger(req.expectedGeneration)||req.expectedGeneration<1||req.expectedGeneration>=Number.MAX_SAFE_INTEGER)return false;
    let db:DispatchStoreConnection|undefined,opened=false,destroy=false;
    try{
      db=await pool.connect();
      // Bound read-only SQL on a separate connection. The existing CORE
      // transaction holds the authority lock; these queries never lock rows.
      await db.query('BEGIN READ ONLY');opened=true;
      await db.query("SET LOCAL statement_timeout='2000ms'");
      await db.query("SET LOCAL lock_timeout='1000ms'");
      const args=[scope.authorityId,req.deviceId];
      const grant=(await db.query('SELECT * FROM core_dispatch.grants WHERE authority_id=$1 AND device_id=$2',args)).rows[0];
      if(!grant||grant.state!=='REVOKING'||grant.owner_id!==req.ownerId||grant.device_epoch!==req.deviceEpoch||
         grant.session_epoch!==req.sessionEpoch||number(grant.generation)!==req.expectedGeneration+1)return false;
      const rows=(await db.query('SELECT * FROM helper_selection.selections WHERE authority_id=$1 AND device_id=$2',args)).rows;
      if(rows.length>1)return false;
      // Other devices without any helper enrollment still require the existing
      // native drain. Never treat a different managed scope as un-enrolled.
      if(req.deviceId!==scope.deviceId)return rows.length===0&&await bounded(()=>existing(req),3500)===true;
      const row=rows[0];
      if(!row||!exactSelectionIdentity(row,scope)||req.ownerId!==scope.ownerId||req.deviceEpoch!==scope.deviceEpoch||
         req.sessionEpoch!==scope.sessionEpoch||req.expectedGeneration!==scope.generation||number(grant.owner_epoch)!==scope.ownerEpoch||
         grant.broker_id!==scope.brokerId)return false;
      const current=selected(row);
      const slots=(await db.query("SELECT * FROM helper_selection.leases WHERE authority_id=$1 AND device_id=$2 AND state<>'RELEASED'",args)).rows;
      if(slots.length>1)return false;
      if(slots[0]){
        const active=lease(slots[0],current);
        const [helperDrained,coreDrained]=await Promise.all([
          verify(Object.freeze({phase:'RELEASE',scope,lease:active,selection:current})),
          bounded(()=>existing(req),3500),
        ]);
        return helperDrained===true&&coreDrained===true;
      }
      return await bounded(()=>existing(req),3500)===true;
    }catch{destroy=true;return false;}
    finally{
      if(db){
        if(opened&&!destroy)try{await db.query('ROLLBACK');}catch{destroy=true;}
        db.release(destroy);
      }
    }
  };
}
/** Read-only exact selection preflight for the sole AI07 production
 * launcher. Never enroll, restore, acquire a lease or change grant state. */
export async function assertHelperSelectionStartup(pool:DispatchStorePool,input:HelperAuthorityScope){
  const scope=Object.freeze(scopeSchema.parse(input));
  const connection=await pool.connect();
  let begun=false,destroy=false;
  try{
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
    await connection.query("SET LOCAL statement_timeout='2000ms'");
    await connection.query("SET LOCAL lock_timeout='1000ms'");
    const args=[scope.authorityId,scope.deviceId];
    const grant=(await connection.query('SELECT * FROM core_dispatch.grants WHERE authority_id=$1 AND device_id=$2',args)).rows[0];
    const row=(await connection.query('SELECT * FROM helper_selection.selections WHERE authority_id=$1 AND device_id=$2',args)).rows[0];
    if(grant?.state!=='ACTIVE'||!exactSelectionIdentity(grant,scope)||!row||!exactSelectionIdentity(row,scope))
      throw Error('HELPER_STARTUP_SCOPE_UNVERIFIED');
    selected(row);
  }catch(error){destroy=true;throw error;}
  finally{
    if(begun&&!destroy)try{await connection.query('ROLLBACK');}catch{destroy=true;}
    connection.release(destroy);
  }
}
