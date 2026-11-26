import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {reviewScheduledAgentV6ForwardEvidence,reviewScheduledAgentV6Evidence,
  type ScheduledAgentV6ForwardReviewInput,type ScheduledAgentV6ReviewInput,
  type ScheduledAgentV6SignerPins,type ScheduledAgentV6Binding} from './windows-scheduled-v6-evidence.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const APP_ID=1314406722;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v),'utf8').digest('hex');
function deny(code:string):never{throw Error('SCHEDULED_AGENT_V6_USE_'+code)}
type ForwardInput=Omit<ScheduledAgentV6ForwardReviewInput,keyof ScheduledAgentV6SignerPins|'nowMs'>;
type ReleaseInput=Omit<ScheduledAgentV6ReviewInput,keyof ScheduledAgentV6SignerPins|'nowMs'>;
export interface ScheduledAgentV6UseStoreConfig {
  authorityId:string;storeId:string;pins:ScheduledAgentV6SignerPins;
}
function exactTask(b:Readonly<ScheduledAgentV6Binding>):string{
  if(b.taskName!=='Nexowire Prelogin Agent'&&b.taskName!=='Nexowire Native Agent')
    return deny('TASK_SCOPE_UNSUPPORTED');
  return b.taskName.toLowerCase();
}
/** Dedicated independent provider-side persistence; NEVER use Agent/Hub DB,
 * expose directly via MCP, or construct from request-supplied pins. This
 * class validates signed bytes and burns attempts, but cannot authenticate
 * the OS observation source, attest loaded image/IPC, prevent DB restore,
 * issue authorization, or perform an OS effect. A separately provisioned
 * service must establish those boundaries before invoking it. */
export class ScheduledAgentV6UseLedger {
  private readonly config:Readonly<ScheduledAgentV6UseStoreConfig>;
  constructor(private readonly db:DatabaseSync,config:ScheduledAgentV6UseStoreConfig){
    if(!UUID.test(config.authorityId)||!UUID.test(config.storeId)||
       !HASH.test(config.pins.forwardSpkiSha256)||!HASH.test(config.pins.releaseSpkiSha256)||
       config.pins.forwardSpkiSha256===config.pins.releaseSpkiSha256)
      deny('STORE_IDENTITY_INVALID');
    this.config=Object.freeze({...config,pins:Object.freeze({...config.pins})});
    this.assertStore();
    const result=db.prepare('PRAGMA quick_check').all();
    if(result.length!==1||result[0]?.quick_check!=='ok')deny('STORE_INTEGRITY_UNKNOWN');
  }
  private assertStore(){
    const db=this.db,c=this.config;
    if(db.isTransaction||db.prepare('PRAGMA application_id').get()?.application_id!==APP_ID||
       db.prepare('PRAGMA user_version').get()?.user_version!==1||
       db.prepare('PRAGMA synchronous').get()?.synchronous!==2||
       db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='wal')deny('STORE_UNPROVISIONED');
    const files=db.prepare('PRAGMA database_list').all().filter(row=>row.name!=='temp');
    if(files.length!==1||files[0]?.name!=='main'||typeof files[0]?.file!=='string'||!files[0].file)
      deny('STORE_UNPROVISIONED');
    const meta=db.prepare('SELECT authority_id,store_id,forward_pin,release_pin FROM main.scheduled_v6_metadata WHERE singleton=1').get();
    if(meta?.authority_id!==c.authorityId||meta?.store_id!==c.storeId||
       meta?.forward_pin!==c.pins.forwardSpkiSha256||meta?.release_pin!==c.pins.releaseSpkiSha256)
      deny('STORE_IDENTITY_MISMATCH');
  }
  private transaction<T>(work:(now:number)=>{result:T;deadline:number}):T{
    this.assertStore();
    const db=this.db;
    let active=false,committing=false;
    try{
      db.exec('BEGIN IMMEDIATE');active=true;
      // The writer lock serializes generation read, clock and consume.
      const row=db.prepare('SELECT max_seen_ms FROM main.scheduled_v6_metadata WHERE singleton=1').get();
      const last=row?.max_seen_ms,now=Date.now();
      if(typeof last!=='number'||!Number.isSafeInteger(last)||last<0||
         !Number.isSafeInteger(now)||now<1||now<last)deny('CLOCK_REWIND_OR_UNKNOWN');
      const {result,deadline}=work(now);
      const after=Date.now();
      if(!Number.isSafeInteger(after)||after<now||after>=deadline)deny('CLOCK_OR_DEADLINE_CHANGED');
      if(Number(db.prepare('UPDATE main.scheduled_v6_metadata SET max_seen_ms=? WHERE singleton=1 AND max_seen_ms=?').run(after,last).changes)!==1)
        deny('CLOCK_CAS_FAILED');
      committing=true;db.exec('COMMIT');active=false;committing=false;
      return result;
    }catch(error){
      if(active&&db.isTransaction)try{db.exec('ROLLBACK');}catch{deny('TRANSACTION_UNKNOWN');}
      if(committing)deny('TRANSACTION_UNKNOWN');
      throw error;
    }
  }
  /** Burn the forward permit before any process creation. No automatic
   * retry even with another UUID or reboot. A newer independent fence
   * generation requires separate reconciliation/authorization by AI05. */
  consumeForward(input:ForwardInput){
    return this.transaction(now=>{
      const review=reviewScheduledAgentV6ForwardEvidence({...input,...this.config.pins,nowMs:now});
      const b=review.verifiedBinding,task=exactTask(b);
      const previous=this.db.prepare('SELECT MAX(fence_generation) AS generation FROM main.scheduled_v6_uses WHERE device_id=? AND installation_id=? AND task_key=?')
        .get(b.deviceId,b.installationId,task)?.generation;
      if(previous!==null&&(typeof previous!=='number'||!Number.isSafeInteger(previous)||previous>=b.fenceGeneration))
        deny('FENCE_REPLAY_OR_STALE');
      const n=this.db.prepare(`INSERT INTO main.scheduled_v6_uses
        (attempt_id,device_id,installation_id,task_key,fence_generation,boot_epoch,binding_sha256,forward_sha256,forward_consumed_at_ms,forward_expires_at_ms,state)
        VALUES(?,?,?,?,?,?,?,?,?,?,'FORWARD_CONSUMED') ON CONFLICT DO NOTHING`)
        .run(b.attemptId,b.deviceId,b.installationId,task,b.fenceGeneration,b.bootEpoch,hash(b),review.forwardSha256,now,review.forwardExpiresAtMs);
      if(Number(n.changes)!==1)deny('FORWARD_REPLAY');
      return {deadline:review.forwardExpiresAtMs,result:Object.freeze({
        attemptId:b.attemptId,forwardSha256:review.forwardSha256,forwardConsumed:true as const,
        releaseConsumed:false as const,activationAuthorized:false as const,releaseAuthorized:false as const,
      })};
    });
  }
  /** Burn exactly the independent signed release following its matching
   * consumed forward. No reissue, recovery, native gate write or launch. */
  consumeRelease(input:ReleaseInput){
    return this.transaction(now=>{
      const review=reviewScheduledAgentV6Evidence({...input,...this.config.pins,nowMs:now});
      const b=review.verifiedBinding,task=exactTask(b);
      // A newer consumed generation fences an older suspended attempt too.
      const n=this.db.prepare(`UPDATE main.scheduled_v6_uses SET
        state='RELEASE_CONSUMED',release_sha256=?,assignment_sha256=?,release_consumed_at_ms=?
        WHERE attempt_id=? AND device_id=? AND installation_id=? AND task_key=? AND fence_generation=?
          AND boot_epoch=? AND binding_sha256=? AND forward_sha256=? AND state='FORWARD_CONSUMED'
          AND forward_consumed_at_ms<=? AND forward_expires_at_ms=? AND forward_expires_at_ms>?
          AND NOT EXISTS(SELECT 1 FROM main.scheduled_v6_uses newer
            WHERE newer.device_id=? AND newer.installation_id=? AND newer.task_key=? AND newer.fence_generation>?)`)
        .run(review.releaseSha256,hash(review.verifiedAssignment),now,b.attemptId,b.deviceId,b.installationId,task,b.fenceGeneration,
          b.bootEpoch,hash(b),review.forwardSha256,review.releaseIssuedAtMs,review.forwardExpiresAtMs,now,
          b.deviceId,b.installationId,task,b.fenceGeneration);
      if(Number(n.changes)!==1)deny('RELEASE_DENIED_OR_REPLAY');
      return {deadline:Math.min(review.forwardExpiresAtMs,review.releaseExpiresAtMs),result:Object.freeze({
        attemptId:b.attemptId,forwardSha256:review.forwardSha256,releaseSha256:review.releaseSha256,
        forwardConsumed:true as const,releaseConsumed:true as const,
        activationAuthorized:false as const,releaseAuthorized:false as const,
      })};
    });
  }
}
