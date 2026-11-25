import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const valid=(pattern:RegExp,value:unknown):value is string=>typeof value==='string'&&pattern.test(value);
const APP_ID=1314406721;
const TTL_MS=30_000;
function deny(reason:string):never{throw Error('RECOVERY_AUTHORIZATION_'+reason)}
export interface RecoveryUseIdentity {
  readonly authorizationId:string;
  readonly deviceId:string;
  /** Stable independently observed cutover identity, NOT a retry/request nonce. */
  readonly transactionSha256:string;
  /** Exact canonical signed scope, approval, lease/boot, evidence and artifact binding. */
  readonly bindingSha256:string;
}
export interface RecoveryUseReservation extends RecoveryUseIdentity {
  readonly authorityId:string;
  readonly storeId:string;
  readonly reservedAtMs:number;
  readonly expiresAtMs:number;
}
function identity(input:RecoveryUseIdentity):RecoveryUseIdentity{
  const {authorizationId,deviceId,transactionSha256,bindingSha256}=input;
  if(!valid(UUID,authorizationId)||!valid(UUID,deviceId)||!valid(HASH,transactionSha256)||!valid(HASH,bindingSha256))
    deny('IDENTITY_INVALID');
  return {authorizationId,deviceId,transactionSha256,bindingSha256};
}
function digest(envelope:Uint8Array):string{
  if(!(envelope instanceof Uint8Array)||envelope.byteLength<1||envelope.byteLength>16384)deny('ENVELOPE_INVALID');
  return createHash('sha256').update(Buffer.from(envelope)).digest('hex');
}
/** Persistence only, for a separately provisioned off-host recovery authority.
 * The exclusive service owns the supplied connection and precreated DB. This
 * component does NOT verify external evidence/signatures, issue a signed grant,
 * hold a native writer fence, or authorize any OS effect. No schema migration,
 * key generation, cleanup, reissue, reset or retry is available here.
 */
export class RecoveryAuthorizationUseLedger {
  constructor(private readonly db:DatabaseSync,private readonly authorityId:string,private readonly storeId:string){
    if(!valid(UUID,authorityId)||!valid(UUID,storeId))deny('STORE_IDENTITY_INVALID');
    this.assertStore();
    const check=db.prepare('PRAGMA quick_check').all();
    if(check.length!==1||check[0]?.quick_check!=='ok')deny('STORE_INTEGRITY_UNKNOWN');
  }
  private assertStore():void{
    const db=this.db;
    if(db.isTransaction||db.prepare('PRAGMA application_id').get()?.application_id!==APP_ID||
       db.prepare('PRAGMA user_version').get()?.user_version!==1||
       db.prepare('PRAGMA synchronous').get()?.synchronous!==2||
       db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='wal')deny('STORE_UNPROVISIONED');
    const files=db.prepare('PRAGMA database_list').all().filter(row=>row.name!=='temp');
    if(files.length!==1||files[0]?.name!=='main'||typeof files[0]?.file!=='string'||!files[0].file)deny('STORE_UNPROVISIONED');
    const rows=db.prepare('SELECT authority_id,store_id FROM main.recovery_authority_metadata WHERE singleton=1').all();
    if(rows.length!==1||rows[0]?.authority_id!==this.authorityId||rows[0]?.store_id!==this.storeId)deny('STORE_IDENTITY_MISMATCH');
  }
  private current(input:RecoveryUseReservation):RecoveryUseReservation{
    const {authorityId,storeId,reservedAtMs,expiresAtMs}=input;
    if(authorityId!==this.authorityId||storeId!==this.storeId||!Number.isSafeInteger(reservedAtMs)||
       !Number.isSafeInteger(expiresAtMs)||reservedAtMs<1||expiresAtMs-reservedAtMs!==TTL_MS)deny('RESERVATION_INVALID');
    return {...identity(input),authorityId,storeId,reservedAtMs,expiresAtMs};
  }
  /** Call only after independent approval/evidence admission. A lost response
   * burns the transaction; never look up and reissue a reserved grant. */
  reserve(input:RecoveryUseIdentity):Readonly<RecoveryUseReservation>{
    this.assertStore();
    const id=identity(input),now=Date.now();
    if(!Number.isSafeInteger(now)||now<1||!Number.isSafeInteger(now+TTL_MS))deny('CLOCK_UNKNOWN');
    const reservation=Object.freeze({...id,authorityId:this.authorityId,storeId:this.storeId,
      reservedAtMs:now,expiresAtMs:now+TTL_MS});
    const result=this.db.prepare(`INSERT INTO main.recovery_authorization_uses
      (transaction_sha256,authorization_id,device_id,binding_sha256,reserved_at_ms,expires_at_ms,state)
      VALUES (?,?,?,?,?,?,'RESERVED') ON CONFLICT DO NOTHING`).run(id.transactionSha256,id.authorizationId,
        id.deviceId,id.bindingSha256,now,reservation.expiresAtMs);
    if(Number(result.changes)!==1)deny('RESERVATION_ALREADY_USED');
    return reservation;
  }
  /** Call after the independent signer has produced the exact signed bytes.
   * Publish them only AFTER this durable CAS succeeds. Never return old bytes. */
  seal(input:RecoveryUseReservation,signedEnvelope:Uint8Array):void{
    this.assertStore();
    const r=this.current(input),sha=digest(signedEnvelope),now=Date.now();
    const result=this.db.prepare(`UPDATE main.recovery_authorization_uses SET state='SEALED',envelope_sha256=?
      WHERE state='RESERVED' AND transaction_sha256=? AND authorization_id=? AND device_id=? AND binding_sha256=?
      AND reserved_at_ms=? AND expires_at_ms=? AND reserved_at_ms<=? AND expires_at_ms>?`).run(sha,r.transactionSha256,
        r.authorizationId,r.deviceId,r.bindingSha256,r.reservedAtMs,r.expiresAtMs,now,now);
    if(Number(result.changes)!==1)deny('SEAL_DENIED');
  }
  /** Burn exactly one published envelope after independent signature and live
   * evidence verification, BEFORE any possible effect. A consumed row is not
   * effect success, and lost ACK/crash must never trigger automatic replay. */
  consume(input:RecoveryUseReservation,signedEnvelope:Uint8Array):void{
    this.assertStore();
    const r=this.current(input),sha=digest(signedEnvelope),now=Date.now();
    const result=this.db.prepare(`UPDATE main.recovery_authorization_uses SET state='CONSUMED',consumed_at_ms=?
      WHERE state='SEALED' AND envelope_sha256=? AND transaction_sha256=? AND authorization_id=? AND device_id=?
      AND binding_sha256=? AND reserved_at_ms=? AND expires_at_ms=? AND reserved_at_ms<=? AND expires_at_ms>?`).run(now,
        sha,r.transactionSha256,r.authorizationId,r.deviceId,r.bindingSha256,r.reservedAtMs,r.expiresAtMs,now,now);
    if(Number(result.changes)!==1)deny('CONSUME_DENIED');
  }
}
