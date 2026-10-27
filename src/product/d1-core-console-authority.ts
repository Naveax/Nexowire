import {createHash} from 'node:crypto';
import type {D1DatabaseLike} from './d1-control-plane-store.js';
import {CoreAuthorityRequestSchema,verifyCoreCertificate,verifyCoreOperation,
  type CoreAuthorityState,type CoreAuthorityRequest} from '../protocol/core-console-authority.js';
import type {CoreConsoleEnrollmentV1} from '../agent/core-console-enrollment-policy.js';

export interface TrustedNativeCoreEnrollmentVerifier {
  /** Must independently verify protected Windows approval, owner/device/logon
   * and consume receipt ID atomically across concurrent Workers. Never trust
   * an Agent-provided JSON witness or merely its timestamp. */
  verifyAndConsume(
    proof:NonNullable<CoreAuthorityRequest['nativeConsent']>,
    expected:CoreConsoleEnrollmentV1,
  ):Promise<boolean>;
  /** Independent fresh native OS/session readback, not Agent-signed report. */
  currentReadback(expected:{ownerAccountId:string;deviceId:string;
    installationId:string;enrollmentId:string;ownerEpoch:number;
    grantGeneration:number;revokeEpoch:number}):Promise<boolean>;
}

const DB_NOW="(CAST(strftime('%s','now') AS INTEGER)*1000)";
const JOIN=`FROM device_core_console_authority c JOIN devices d ON d.id=c.device_id
 LEFT JOIN device_maintenance_preferences p ON p.device_id=d.id AND p.owner_account_id=d.owner_account_id
 LEFT JOIN device_bridge_preferences b ON b.device_id=d.id AND b.owner_account_id=d.owner_account_id`;
const READY=`d.access_mode='full' AND d.online=1 AND d.platform='win32' AND d.privilege_mode='broker'
 AND d.admin_bridge_ready=1 AND p.enabled=1 AND COALESCE(b.desired_mode,'auto')<>'off'`;
type Row={device_id:string;owner_account_id:string;installation_id:string|null;authority_time_ms:number;
  enrollment_id:string|null;public_key_spki:string|null;owner_epoch:number;grant_generation:number;
  revoke_epoch:number;core_enabled:number;access_mode:'safe'|'full';online:number;bridge_verified:number;
  physical_active:number;status_observed_at_ms:number|null;enrollment_requested:number};
export interface CoreConsoleAuthority {
  requestEnrollment?(deviceId:string,ownerAccountId:string):Promise<void>;
  handle(credential:string,raw:unknown):Promise<{nonce:string;state:CoreAuthorityState}>;
  deviceStatus?(deviceId:string,ownerAccountId:string):Promise<{
    localEnrolled:boolean;active:boolean;observedAtMs:number|null;
    enrollmentRequested?:boolean;deviceReady?:boolean}>;
}
/** Independent D1 rows and one-use IDs survive restoration of Agent-local state. */
export class D1CoreConsoleAuthority implements CoreConsoleAuthority {
  constructor(private readonly db:D1DatabaseLike,
    private readonly nativeEnrollmentVerifier?:TrustedNativeCoreEnrollmentVerifier){}
  private async row(hash:string,id:string):Promise<Row>{
    const row=await this.db.prepare(`SELECT ${DB_NOW} authority_time_ms,d.id device_id,d.owner_account_id,c.installation_id,
      c.enrollment_id,c.public_key_spki,c.owner_epoch,c.grant_generation,c.revoke_epoch,
      CASE WHEN p.enabled=1 AND COALESCE(b.desired_mode,'auto')<>'off' THEN 1 ELSE 0 END core_enabled,
      d.access_mode,d.online,CASE WHEN d.privilege_mode='broker' AND d.admin_bridge_ready=1 THEN 1 ELSE 0 END bridge_verified,
      c.physical_active,c.status_observed_at_ms,c.enrollment_requested ${JOIN} WHERE d.id=? AND d.credential_hash=?`)
      .bind(id,hash).first<Row>();
    if(!row)throw new Error('CORE_DEVICE_UNAUTHENTICATED');
    return row;
  }
  async handle(credential:string,raw:unknown){
    const r=CoreAuthorityRequestSchema.parse(raw);
    if(!/^nwx_dev_[A-Za-z0-9_-]{8,500}$/.test(credential))throw new Error('CORE_DEVICE_UNAUTHENTICATED');
    const hash=createHash('sha256').update(credential).digest('hex');
    const before=await this.row(hash,r.deviceId);
    if(r.action!=='read'){
    const nonce=await this.db.prepare(`INSERT INTO device_core_console_nonces(nonce,device_id,observed_at_ms)
      SELECT ?,?,${DB_NOW} WHERE ? BETWEEN ${DB_NOW}-30000 AND ${DB_NOW}+5000
      ON CONFLICT(nonce) DO NOTHING`).bind(r.nonce,r.deviceId,r.issuedAtMs).run();
    if(nonce.success===false||nonce.meta?.changes!==1)throw new Error('CORE_NONCE_REPLAY_OR_EXPIRED');
    // Old nonces can be deleted safely because their signed timestamps can no
    // longer pass the database-clock predicate. Operation IDs are NEVER pruned.
    await this.db.prepare(`DELETE FROM device_core_console_nonces WHERE observed_at_ms<${DB_NOW}-60000`).run();
    }
    const currentPredicate=`c.device_id=? AND d.credential_hash=? AND ${READY}
      AND c.installation_id=? AND c.enrollment_id=? AND c.public_key_spki=?
      AND c.owner_epoch=? AND c.grant_generation=? AND c.revoke_epoch=?`;
    const currentArgs=[r.deviceId,hash,r.installationId,before.enrollment_id,
      before.public_key_spki,before.owner_epoch,before.grant_generation,before.revoke_epoch];
    const changed=async(sql:string,args:unknown[])=>{
      const result=await this.db.prepare(sql).bind(...args).run();
      if(result.success===false||result.meta?.changes!==1)throw new Error('CORE_REVOKED_REPLAY_OR_CONFLICT');
    };
    if(r.action==='enroll'){
      const cert=verifyCoreCertificate(r.certificate,r.publicKeySpki??'');
      const e=cert.enrollment;
      if(e.ownerAccountId!==before.owner_account_id||e.deviceId!==r.deviceId||e.installationId!==r.installationId||
        e.ownerEpoch!==before.owner_epoch||e.grantGeneration!==before.grant_generation||e.revokeEpoch!==before.revoke_epoch||
        !verifyCoreOperation(r,r.publicKeySpki!))throw new Error('CORE_ENROLLMENT_BINDING_INVALID');
      // Verify local-decision freshness against the independent DB clock.
      // The timestamp is signed but is not independent proof of Windows consent.
      if(e.approvedLocallyAtMs<before.authority_time_ms-300000||
         e.approvedLocallyAtMs>before.authority_time_ms+5000)
        throw new Error('CORE_LOCAL_DECISION_NOT_FRESH');
      // The device itself can self-sign an arbitrary timestamp and receipt.
      // Default D1 composition has NO independent native proof authority.
      // Deny direct-to-Worker enrollment even with a valid paired credential.
      if(!this.nativeEnrollmentVerifier||!r.nativeConsent)
        throw new Error('CORE_NATIVE_CONSENT_PROVIDER_UNAVAILABLE');
      const proof=r.nativeConsent;
      if(proof.ownerAccountId!==e.ownerAccountId||proof.deviceId!==e.deviceId||
        proof.installationId!==e.installationId||proof.enrollmentId!==e.enrollmentId||
        proof.ownerEpoch!==e.ownerEpoch||proof.grantGeneration!==e.grantGeneration||
        proof.revokeEpoch!==e.revokeEpoch||proof.approvedAtMs!==e.approvedLocallyAtMs)
        throw new Error('CORE_NATIVE_CONSENT_SCOPE_MISMATCH');
      // Native verifier must provide authenticated OS owner/session readback
      // and a durable one-shot CAS. No dev fixture is a production verifier.
      if(await this.nativeEnrollmentVerifier.verifyAndConsume(proof,e)!==true)
        throw new Error('CORE_NATIVE_CONSENT_NOT_VERIFIED');
      await changed(`UPDATE device_core_console_authority SET installation_id=?,enrollment_id=?,public_key_spki=?,enrollment_requested=0,physical_active=0
        WHERE device_id=? AND owner_epoch=? AND grant_generation=? AND revoke_epoch=?
        AND enrollment_id IS NULL AND EXISTS(SELECT 1 ${JOIN}
          WHERE d.id=? AND d.credential_hash=? AND ${READY})`,
        [r.installationId,e.enrollmentId,r.publicKeySpki,r.deviceId,e.ownerEpoch,e.grantGeneration,e.revokeEpoch,r.deviceId,hash]);
    }else if(r.action==='dismiss'){
      await changed(`UPDATE device_core_console_authority SET enrollment_requested=0 WHERE device_id=? AND owner_epoch=?
        AND EXISTS(SELECT 1 FROM devices WHERE id=? AND credential_hash=?)`,[r.deviceId,before.owner_epoch,r.deviceId,hash]);
    }else if(r.action==='revoke'){
      // Cleanup is allowed in SAFE and after CORE OFF; paired credential still required.
      await changed(`UPDATE device_core_console_authority SET revoke_epoch=revoke_epoch+1,
        installation_id=NULL,enrollment_id=NULL,public_key_spki=NULL,enrollment_requested=0,physical_active=0
        WHERE device_id=? AND EXISTS(SELECT 1 FROM devices WHERE id=? AND credential_hash=?)`,[r.deviceId,r.deviceId,hash]);
    }else if(r.action!=='read'){
      if(!before.public_key_spki||before.installation_id!==r.installationId||
        !verifyCoreOperation(r,before.public_key_spki))throw new Error('CORE_LOCAL_SIGNATURE_REQUIRED');
      if(r.action==='report'){
        await changed(`UPDATE device_core_console_authority SET physical_active=?,status_observed_at_ms=${DB_NOW}
          WHERE device_id IN(SELECT c.device_id ${JOIN} WHERE ${currentPredicate})`,[r.active===true?1:0,...currentArgs]);
      }else{
        if(!r.requestId||!r.fingerprint)throw new Error('CORE_OPERATION_ID_REQUIRED');
        const opArgs=[r.requestId,r.fingerprint,r.deviceId,r.installationId,before.enrollment_id,
          before.owner_epoch,before.grant_generation,before.revoke_epoch];
        if(r.action==='reserve'){
          await changed(`INSERT INTO device_core_console_operations
            (request_id,fingerprint,device_id,installation_id,enrollment_id,owner_epoch,grant_generation,revoke_epoch,state,reserved_at_ms)
            SELECT ?,?,c.device_id,c.installation_id,c.enrollment_id,c.owner_epoch,c.grant_generation,c.revoke_epoch,'reserved',${DB_NOW}
            ${JOIN} WHERE ${currentPredicate} ON CONFLICT(request_id) DO NOTHING`,[r.requestId,r.fingerprint,...currentArgs]);
        }else if(r.action==='claim'){
          await changed(`UPDATE device_core_console_operations SET state='dispatched'
            WHERE request_id=? AND fingerprint=? AND device_id=? AND installation_id=? AND enrollment_id=?
              AND owner_epoch=? AND grant_generation=? AND revoke_epoch=? AND state='reserved'
              AND reserved_at_ms>=${DB_NOW}-30000 AND reserved_at_ms<=${DB_NOW}
              AND device_id IN(SELECT c.device_id ${JOIN} WHERE ${currentPredicate})`,[...opArgs,...currentArgs]);
        }else if(r.action==='complete'){
          if(!r.outcome)throw new Error('CORE_OUTCOME_REQUIRED');
          await changed(`UPDATE device_core_console_operations SET state=?
            WHERE request_id=? AND fingerprint=? AND device_id=? AND installation_id=? AND enrollment_id=?
              AND owner_epoch=? AND grant_generation=? AND revoke_epoch=? AND state='dispatched'
              AND device_id IN(SELECT c.device_id ${JOIN} WHERE ${currentPredicate})`,[r.outcome,...opArgs,...currentArgs]);
        }
      }
    }
    const row=await this.row(hash,r.deviceId);
    return {nonce:r.nonce,state:this.state(row,r.installationId)};
  }
  private state(row:Row,installation:string):CoreAuthorityState {
    return {authorityTimeMs:row.authority_time_ms,ownerAccountId:row.owner_account_id,deviceId:row.device_id,
      installationId:row.installation_id??installation,ownerEpoch:row.owner_epoch,
      grantGeneration:row.grant_generation,revokeEpoch:row.revoke_epoch,
      coreEnabled:row.core_enabled===1,enrollmentRequested:row.enrollment_requested===1,
      accessMode:row.access_mode,deviceOnline:row.online===1,
      bridgeVerified:row.bridge_verified===1,enrollmentId:row.enrollment_id,
      publicKeySpki:row.public_key_spki,physicalActive:row.physical_active===1,
      statusObservedAtMs:row.status_observed_at_ms};
  }
  async requestEnrollment(deviceId:string,ownerAccountId:string){
    if(!this.nativeEnrollmentVerifier)throw new Error('CORE_NATIVE_CONSENT_PROVIDER_UNAVAILABLE');
    // Only the FIRST enrollment can be queued. Re-queueing an already
    // certified device can mislead the UI and trigger unwanted local consent.
    // Keep this predicate in the same D1 UPDATE to close the read/write race.
    const result=await this.db.prepare(`UPDATE device_core_console_authority SET enrollment_requested=1
      WHERE enrollment_id IS NULL AND device_id IN(SELECT c.device_id ${JOIN}
        WHERE d.id=? AND d.owner_account_id=? AND ${READY})`)
      .bind(deviceId,ownerAccountId).run();
    if(result.success===false||result.meta?.changes!==1){
      const current=await this.deviceStatus(deviceId,ownerAccountId);
      if(current.localEnrolled)throw new Error('CORE_ALREADY_ENROLLED');
      throw new Error('CORE_DEVICE_NOT_READY');
    }
  }
  async deviceStatus(deviceId:string,ownerAccountId:string){
    type StatusRow={enrollment_id:string|null;installation_id:string|null;
      owner_epoch:number;grant_generation:number;revoke_epoch:number;
      enrollment_requested:number;device_ready:number;physical_active:number;
      status_observed_at_ms:number|null;fresh:number};
    const readRow=()=>this.db.prepare(`SELECT c.enrollment_id,c.enrollment_requested,
      c.installation_id,c.owner_epoch,c.grant_generation,c.revoke_epoch,
      c.physical_active,c.status_observed_at_ms,
      CASE WHEN ${READY} THEN 1 ELSE 0 END device_ready,
      CASE WHEN ${READY} AND c.status_observed_at_ms>=${DB_NOW}-15000 THEN 1 ELSE 0 END fresh
      ${JOIN} WHERE d.id=? AND d.owner_account_id=?`).bind(deviceId,ownerAccountId).first<StatusRow>();
    let row=await readRow();
    let nativeCurrent=false;
    if(row?.enrollment_id&&row.installation_id&&this.nativeEnrollmentVerifier){
      try {
        nativeCurrent=await this.nativeEnrollmentVerifier.currentReadback({
          ownerAccountId,deviceId,installationId:row.installation_id,
          enrollmentId:row.enrollment_id,ownerEpoch:row.owner_epoch,
          grantGeneration:row.grant_generation,revokeEpoch:row.revoke_epoch})===true;
        // The independent OS readback is async. A revoke, CORE OFF or
        // re-pair can occur while it runs. Never surface an old D1 row as
        // current after that await; recheck identity/generation and readiness.
        const latest=await readRow();
        nativeCurrent=nativeCurrent&&!!latest&&latest.enrollment_id===row.enrollment_id&&
          latest.installation_id===row.installation_id&&
          latest.owner_epoch===row.owner_epoch&&
          latest.grant_generation===row.grant_generation&&
          latest.revoke_epoch===row.revoke_epoch&&latest.device_ready===1;
        row=latest;
      }catch{nativeCurrent=false;row=null;}
    }
    // Never infer OS-local human approval from a D1 row or signed Agent report.
    return {localEnrolled:nativeCurrent,
      active:nativeCurrent&&row?.fresh===1&&row.physical_active===1,
      observedAtMs:row?.status_observed_at_ms??null,
      enrollmentRequested:!!this.nativeEnrollmentVerifier&&row?.enrollment_requested===1,
      deviceReady:!!this.nativeEnrollmentVerifier&&row?.device_ready===1};
  }
}
