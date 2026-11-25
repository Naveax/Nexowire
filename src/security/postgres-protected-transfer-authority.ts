import {createHash,createPublicKey,randomUUID,randomBytes} from 'node:crypto';
import path from 'node:path';
import type {DispatchStorePool,DispatchStoreConnection} from '../agent/postgres-broker-dispatch-authority.js';
import type {IndependentProvenanceCheck} from '../agent/postgres-monotonic-witness.js';
import {verifyNativeTransferReceipt} from '../agent/native-transfer-publisher.js';
import {transferNativeClaimDigest,type ProtectedTransferAuthorityBackend,type TransferNativeClaim} from './protected-transfer-authority.js';
import type {LargeTransferScope,LargeTransferBinding,LargeTransferLease,LargeTransferIntent,LargeTransferFinalReceipt,LargeTransferCommit} from '../mcp/durable-large-transfer.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,hex=/^[a-f0-9]{64}$/;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const deny=(code:string):never=>{throw Error(code);};
const fields=['ownerId','projectId','sourceDeviceId','targetDeviceId','id','sourcePath','targetPath','stagePath','size','sha256'] as const;
const intentFields=['kind','requestId','epoch','offset','length','sha256','dispatched'] as const;
const sameBinding=(a:unknown,b:LargeTransferBinding)=>!!a&&typeof a==='object'&&Object.keys(a).length===fields.length&&fields.every(k=>(a as LargeTransferBinding)[k]===b[k]);
const sameIntent=(a:unknown,b:LargeTransferIntent)=>!!a&&typeof a==='object'&&Object.keys(a).length===intentFields.length&&intentFields.every(k=>(a as LargeTransferIntent)[k]===b[k]);
type Row=Record<string,unknown>;
type Tx={db:DispatchStoreConnection;now:()=>Promise<number>};
function integer(x:unknown,min=0){const n=typeof x==='string'&&/^\d+$/.test(x)?Number(x):x;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<min)return deny('TRANSFER_PG_STATE_INVALID');return n;}
function scopeValid(s:LargeTransferScope){if(!s||!uuid.test(s.ownerId)||!uuid.test(s.sourceDeviceId)||!uuid.test(s.targetDeviceId)||s.sourceDeviceId===s.targetDeviceId||!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(s.projectId))deny('TRANSFER_PG_SCOPE_INVALID');}
function canonicalWin(p:string){return typeof p==='string'&&p.length<=4096&&/^[A-Z]:\\/i.test(p)&&p===path.win32.resolve(p)&&!p.includes('/')&&!p.slice(2).includes(':')&&!p.split('\\').slice(1).some(s=>!s||/[. ]$/.test(s)||/[\x00-\x1f<>:"/|?*]/.test(s)||/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(s));}
function bindingValid(b:LargeTransferBinding){scopeValid(b);if(!uuid.test(b.id)||!canonicalWin(b.sourcePath)||!canonicalWin(b.targetPath)||!canonicalWin(b.stagePath)||b.targetPath.toLowerCase().includes('.nexowire-upload-')||b.stagePath!==b.targetPath+'.nexowire-upload-'+b.id+'.part'||!Number.isSafeInteger(b.size)||b.size<0||!hex.test(b.sha256)||b.size===0&&b.sha256!==sha(''))deny('TRANSFER_PG_BINDING_INVALID');}
function leaseValid(l:LargeTransferLease){if(!l||!Number.isSafeInteger(l.epoch)||l.epoch<1||typeof l.token!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(l.token))deny('TRANSFER_PG_LEASE_INVALID');}
function receiptMatches(b:LargeTransferBinding,p:LargeTransferIntent,r:LargeTransferFinalReceipt){return p.kind==='publish'&&p.dispatched&&r.jobId===b.id&&r.requestId===p.requestId&&r.epoch===p.epoch&&r.targetDeviceId===b.targetDeviceId&&r.targetPath===b.targetPath&&r.size===b.size&&r.sha256===b.sha256;}
export interface IndependentTransferObservation {
  jobId:string;requestId:string;epoch:number;intentSha256:string;
  /** The exact original permit can NEVER run again, including delayed ACKs,
   * old processes and restore. An idle socket or local PID check is not proof. */
  sealed:true;
  state:'applied'|'no-effect'|'unknown';
  offset:number;length:number;sha256:string;
}
export interface PostgresProtectedTransferConfig {
  pool:DispatchStorePool;authorityId:string;verifyProvenance:IndependentProvenanceCheck;
  /** Independently authenticated, signed protected Native readback of the
   * original intent and permanent drain/fence. Must NOT trust Hub progress. */
  observeNativeIntent:(b:Readonly<LargeTransferBinding>,p:Readonly<LargeTransferIntent>,c:Readonly<TransferNativeClaim>)=>Promise<IndependentTransferObservation|undefined>;
  readNativeReceipt:(b:Readonly<LargeTransferBinding>,p:Readonly<LargeTransferIntent>)=>Promise<LargeTransferFinalReceipt|undefined>;
}
/** Independent PostgreSQL implementation. No Agent-local DB, automatic
 * schema/grant creation or fallbacks. All transactions share the EXACT
 * core_dispatch.authorities lock used by the existing revoke fence. */
export class PostgresProtectedTransferAuthority implements ProtectedTransferAuthorityBackend {
  private readonly config:Readonly<PostgresProtectedTransferConfig>;
  constructor(c:PostgresProtectedTransferConfig){
    if(!c||!uuid.test(c.authorityId)||typeof c.pool?.connect!=='function'||typeof c.verifyProvenance!=='function'||typeof c.observeNativeIntent!=='function'||typeof c.readNativeReceipt!=='function')deny('TRANSFER_PG_CONFIG_INVALID');
    this.config=Object.freeze({...c});
  }
  private async trusted(){const p=await this.config.verifyProvenance();if(!p||p.verified!==true||p.authorityId!==this.config.authorityId||!Number.isSafeInteger(p.validUntil)||p.validUntil<=Date.now())deny('TRANSFER_PG_PROVENANCE_UNVERIFIED');}
  private async tx<T>(f:(tx:Tx)=>Promise<T>):Promise<T>{
    await this.trusted();const db=await this.config.pool.connect();let active=false,committing=false,destroy=false;
    try{
      await db.query('BEGIN');active=true;
      await db.query("SET LOCAL synchronous_commit='on'");await db.query("SET LOCAL statement_timeout='5000ms'");await db.query("SET LOCAL lock_timeout='3000ms'");
      const settings=(await db.query("SELECT current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes,pg_is_in_recovery() AS recovery,"+
        "(SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated,"+
        "has_schema_privilege(current_user,'transfer_authority','CREATE') AS ddl,"+
        "has_table_privilege(current_user,'transfer_authority.grants','INSERT,UPDATE,DELETE,TRUNCATE') AS grant_write,"+
        "(has_table_privilege(current_user,'transfer_authority.jobs','DELETE,TRUNCATE') OR has_table_privilege(current_user,'transfer_authority.claims','DELETE,TRUNCATE')) AS erase,"+
        "EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='transfer_authority' AND pg_has_role(current_user,c.relowner,'MEMBER')) AS owns")).rows[0];
      if(!settings||settings.fsync!=='on'||settings.full_page_writes!=='on'||settings.recovery!==false||settings.elevated!==false||settings.ddl!==false||settings.grant_write!==false||settings.erase!==false||settings.owns!==false)deny('TRANSFER_PG_ROLE_OR_DURABILITY_INVALID');
      const locked=(await db.query('SELECT max_seen_ms FROM core_dispatch.authorities WHERE authority_id=$1 FOR UPDATE',[this.config.authorityId])).rows[0];if(!locked)deny('TRANSFER_PG_AUTHORITY_MISSING');
      let last=integer(locked?.max_seen_ms,1);
      const now=async()=>{const x=integer((await db.query('SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS ms')).rows[0]?.ms,1);if(x<last)deny('TRANSFER_PG_CLOCK_REWIND');last=x;return x;};
      await now();const result=await f({db,now});await this.trusted();await now();
      await db.query('UPDATE core_dispatch.authorities SET max_seen_ms=$2 WHERE authority_id=$1',[this.config.authorityId,last]);
      committing=true;await db.query('COMMIT');active=false;committing=false;return result;
    }catch(e){if(committing){destroy=true;return deny('TRANSFER_PG_TRANSACTION_UNKNOWN');}if(active)try{await db.query('ROLLBACK');}catch{destroy=true;}throw e;}
    finally{db.release(destroy);}
  }
  private async grant(tx:Tx,s:LargeTransferScope,b?:LargeTransferBinding){
    scopeValid(s);const v=[this.config.authorityId,s.ownerId,s.projectId,s.sourceDeviceId,s.targetDeviceId];
    const g=(await tx.db.query('SELECT * FROM transfer_authority.grants WHERE authority_id=$1 AND owner_id=$2 AND project_id=$3 AND source_device_id=$4 AND target_device_id=$5',v)).rows[0];
    if(!g||g.state!=='ACTIVE'||integer(g.expires_ms,1)<=await tx.now())return deny('TRANSFER_PG_GRANT_REVOKED');
    // Existing CORE revoke/re-pair owns the shared authority lock. Exact
    // owner, device/session epochs and grant generation cannot be rebound.
    for(const [side,device] of [['source',s.sourceDeviceId],['target',s.targetDeviceId]] as const){
      const row=(await tx.db.query('SELECT * FROM core_dispatch.grants WHERE authority_id=$1 AND device_id=$2',[this.config.authorityId,device])).rows[0];
      if(!row||row.state!=='ACTIVE'||row.owner_id!==s.ownerId||row.device_epoch!==g[side+'_device_epoch']||row.session_epoch!==g[side+'_session_epoch']||integer(row.owner_epoch,1)!==integer(g[side+'_owner_epoch'],1)||integer(row.generation,1)!==integer(g[side+'_generation'],1))return deny('TRANSFER_PG_GRANT_REVOKED');
    }
    if(b){
      bindingValid(b);const src=g.source_root,dst=g.target_root;
      if(typeof src!=='string'||typeof dst!=='string'||!canonicalWin(src)||!canonicalWin(dst)||!/^C:\\ProgramData\\/i.test(dst)||
        !b.sourcePath.toLowerCase().startsWith(src.toLowerCase()+'\\')||path.win32.dirname(b.targetPath)!==dst||path.win32.dirname(b.stagePath)!==dst)return deny('TRANSFER_PG_PATH_DENIED');
    }
    if(typeof g.target_public_key_pem!=='string'||g.target_public_key_pem.length>4096)return deny('TRANSFER_PG_SIGNER_UNENROLLED');
    const key=createPublicKey(g.target_public_key_pem);if(key.asymmetricKeyType!=='ed25519')return deny('TRANSFER_PG_SIGNER_UNENROLLED');return key;
  }
  private async job(tx:Tx,b:LargeTransferBinding){bindingValid(b);const j=(await tx.db.query('SELECT * FROM transfer_authority.jobs WHERE id=$1 AND authority_id=$2 FOR UPDATE',[b.id,this.config.authorityId])).rows[0];if(!j||!sameBinding(j.binding,b))return deny('TRANSFER_PG_JOB_SCOPE_DENIED');return j;}
  private active(j:Row,l?:LargeTransferLease){if(j.state!=='ACTIVE')deny('TRANSFER_PG_JOB_FENCED');if(l){leaseValid(l);if(integer(j.epoch,1)!==l.epoch||j.lease_hash!==sha(l.token))deny('TRANSFER_PG_LEASE_FENCED');}}
  private async pending(tx:Tx,j:Row,b:LargeTransferBinding){
    if(j.pending_id===null)return undefined;
    const c=(await tx.db.query('SELECT * FROM transfer_authority.claims WHERE request_id=$1 AND job_id=$2 FOR UPDATE',[j.pending_id,b.id])).rows[0];
    if(!c||typeof c.claim_id!=='string'||typeof c.intent_hash!=='string'||!hex.test(c.intent_hash)||!c.intent||typeof c.intent!=='object')return deny('TRANSFER_PG_PENDING_CORRUPT');
    const p=c.intent as LargeTransferIntent;
    if(p.requestId!==c.request_id||p.epoch!==integer(c.epoch,1)||!p.dispatched||!['ACTIVE','SETTLED','UNKNOWN','SEALED'].includes(String(c.state)))return deny('TRANSFER_PG_PENDING_CORRUPT');
    return {row:c,p,claim:Object.freeze({claimId:c.claim_id,jobId:b.id,requestId:p.requestId,epoch:p.epoch,intentSha256:c.intent_hash}) as TransferNativeClaim};
  }
  private async observe(b:LargeTransferBinding,p:LargeTransferIntent,c:TransferNativeClaim){
    const v=await this.config.observeNativeIntent(b,p,c);
    if(!v||v.sealed!==true||v.jobId!==b.id||v.requestId!==p.requestId||v.epoch!==p.epoch||v.intentSha256!==c.intentSha256||v.offset!==p.offset||v.length!==p.length||v.sha256!==p.sha256||!['applied','no-effect','unknown'].includes(v.state))return deny('TRANSFER_PG_NATIVE_DRAIN_UNVERIFIED');
    return v.state;
  }
  async assertGrant(s:LargeTransferScope){await this.tx(async tx=>{await this.grant(tx,s);});}
  async acquire(b:LargeTransferBinding,previousEpoch:number){bindingValid(b);if(!Number.isSafeInteger(previousEpoch)||previousEpoch<0)return deny('TRANSFER_PG_LEASE_INVALID');
    return this.tx(async tx=>{
      await this.grant(tx,b,b);
      const exists=(await tx.db.query('SELECT id FROM transfer_authority.jobs WHERE id=$1',[b.id])).rows[0];
      const token=randomBytes(32).toString('hex'),hash=sha(token);
      if(!exists){
        if(previousEpoch!==0)return deny('TRANSFER_PG_JOB_SCOPE_DENIED');
        await tx.db.query('INSERT INTO transfer_authority.jobs(id,authority_id,owner_id,project_id,source_device_id,target_device_id,target_path_key,binding,epoch,lease_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9)',[b.id,this.config.authorityId,b.ownerId,b.projectId,b.sourceDeviceId,b.targetDeviceId,b.targetPath.toLowerCase(),JSON.stringify(b),hash]);
        return {epoch:1,token};
      }
      const j=await this.job(tx,b);this.active(j);const old=integer(j.epoch,1);
      if(previousEpoch===0||previousEpoch>old||old===Number.MAX_SAFE_INTEGER)return deny('TRANSFER_PG_LEASE_FENCED');
      const pending=await this.pending(tx,j,b);
      if(pending){
        if(pending.p.kind!=='write')return deny('TRANSFER_PG_PUBLICATION_UNRESOLVED');
        await this.observe(b,pending.p,pending.claim);
        if(pending.row.state!=='SEALED')await tx.db.query("UPDATE transfer_authority.claims SET state='SEALED' WHERE request_id=$1",[pending.p.requestId]);
      }
      const epoch=old+1;await this.grant(tx,b,b);
      await tx.db.query('UPDATE transfer_authority.jobs SET epoch=$2,lease_hash=$3 WHERE id=$1',[b.id,epoch,hash]);return {epoch,token};
    });
  }
  async assertCurrent(b:LargeTransferBinding,l:LargeTransferLease,offset:number){
    if(!Number.isSafeInteger(offset)||offset<0||offset>b.size)deny('TRANSFER_PG_OFFSET_INVALID');
    await this.tx(async tx=>{
      await this.grant(tx,b,b);const j=await this.job(tx,b);this.active(j,l);const old=integer(j.confirmed_offset);
      const pending=await this.pending(tx,j,b);
      if(!pending||pending.p.kind==='publish'){if(offset!==old)deny('TRANSFER_PG_OFFSET_FENCED');return;}
      const p=pending.p;
      if(p.offset!==old)deny('TRANSFER_PG_PENDING_CORRUPT');
      // The worker's post-write old-offset recheck is NOT an advance permit.
      // A later claim at that offset still sees pending_id and must deny.
      if(offset===old&&p.length>0)return;
      if(offset!==p.offset+p.length||await this.observe(b,p,pending.claim)!=='applied')return deny('TRANSFER_PG_NATIVE_WRITE_UNVERIFIED');
      await this.grant(tx,b,b);
      await tx.db.query("UPDATE transfer_authority.claims SET state='APPLIED' WHERE request_id=$1",[p.requestId]);
      await tx.db.query('UPDATE transfer_authority.jobs SET confirmed_offset=$2,stage_created=true,pending_id=NULL WHERE id=$1',[b.id,offset]);
    });
  }
  async proveWriteNoEffect(b:LargeTransferBinding,p:LargeTransferIntent,l:LargeTransferLease){
    if(p.kind!=='write'||!uuid.test(p.requestId)||!Number.isSafeInteger(p.epoch)||p.epoch<1||l.epoch<=p.epoch)return false;
    return this.tx(async tx=>{
      await this.grant(tx,b,b);const j=await this.job(tx,b);this.active(j,l);
      if(integer(j.confirmed_offset)!==p.offset)return false;
      const pending=await this.pending(tx,j,b);
      if(!pending){
        // The new monotonic epoch is already installed under the shared lock;
        // absence of a global original claim cannot authorize a late old claim.
        return !(await tx.db.query('SELECT request_id FROM transfer_authority.claims WHERE request_id=$1',[p.requestId])).rows[0];
      }
      if(!sameIntent(pending.p,p)||pending.row.state!=='SEALED'||await this.observe(b,p,pending.claim)!=='no-effect')return false;
      await tx.db.query("UPDATE transfer_authority.claims SET state='NO_EFFECT' WHERE request_id=$1",[p.requestId]);
      await tx.db.query('UPDATE transfer_authority.jobs SET pending_id=NULL WHERE id=$1',[b.id]);return true;
    });
  }
  async claimNativeEffect(b:LargeTransferBinding,l:LargeTransferLease,p:LargeTransferIntent){
    bindingValid(b);leaseValid(l);const intentHash=transferNativeClaimDigest(b,l,p);
    if(!p.dispatched||p.epoch!==l.epoch)return deny('TRANSFER_PG_INTENT_INVALID');
    return this.tx(async tx=>{
      await this.grant(tx,b,b);const j=await this.job(tx,b);this.active(j,l);
      if(j.pending_id!==null||integer(j.confirmed_offset)!==p.offset||p.kind==='publish'&&(j.stage_created!==true||p.offset!==b.size)||p.kind==='write'&&p.length===0&&j.stage_created===true)return deny('TRANSFER_PG_MUTATION_UNRESOLVED');
      if((await tx.db.query('SELECT request_id FROM transfer_authority.claims WHERE request_id=$1',[p.requestId])).rows[0])return deny('TRANSFER_PG_REQUEST_REPLAY');
      const claimId=randomUUID();
      await tx.db.query("INSERT INTO transfer_authority.claims(request_id,job_id,claim_id,epoch,lease_hash,intent_hash,intent,state) VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE')",[p.requestId,b.id,claimId,l.epoch,sha(l.token),intentHash,JSON.stringify(p)]);
      await tx.db.query('UPDATE transfer_authority.jobs SET pending_id=$2 WHERE id=$1',[b.id,p.requestId]);
      return {claimId,jobId:b.id,requestId:p.requestId,epoch:l.epoch,intentSha256:intentHash};
    });
  }
  async settleNativeEffect(b:LargeTransferBinding,l:LargeTransferLease,p:LargeTransferIntent,c:TransferNativeClaim,outcome:'completed'|'unknown'){
    leaseValid(l);const h=transferNativeClaimDigest(b,l,p);
    if(!p.dispatched||p.epoch!==l.epoch||c.jobId!==b.id||c.requestId!==p.requestId||c.epoch!==l.epoch||c.intentSha256!==h||!uuid.test(c.claimId)||(outcome!=='completed'&&outcome!=='unknown'))deny('TRANSFER_PG_CLAIM_SCOPE_DENIED');
    await this.tx(async tx=>{
      // Original native settlement may occur after shared grant revoke.
      // No new authorization, no deletion, no generation rollback.
      const j=await this.job(tx,b),pending=await this.pending(tx,j,b);
      if(!pending||pending.row.state!=='ACTIVE'||pending.row.lease_hash!==sha(l.token)||pending.claim.claimId!==c.claimId||pending.claim.intentSha256!==h||!sameIntent(pending.p,p))return deny('TRANSFER_PG_CLAIM_SCOPE_DENIED');
      await tx.db.query('UPDATE transfer_authority.claims SET state=$2 WHERE request_id=$1',[p.requestId,outcome==='completed'?'SETTLED':'UNKNOWN']);
    });
  }
  async verifyFinal(b:LargeTransferBinding,r:LargeTransferFinalReceipt){return this.tx(async tx=>verifyNativeTransferReceipt(b,r,await this.grant(tx,b,b)));}
  private async finish(tx:Tx,b:LargeTransferBinding,j:Row,p:LargeTransferIntent,r:LargeTransferFinalReceipt){
    const key=await this.grant(tx,b,b),pending=await this.pending(tx,j,b);
    if(!pending||!sameIntent(pending.p,p)||!receiptMatches(b,p,r)||!verifyNativeTransferReceipt(b,r,key)||await this.observe(b,p,pending.claim)!=='applied')return deny('TRANSFER_PG_PUBLICATION_UNVERIFIED');
    const actual=await this.config.readNativeReceipt(b,p);
    if(!actual||!receiptMatches(b,p,actual)||!verifyNativeTransferReceipt(b,actual,key)||actual.proof!==r.proof)return deny('TRANSFER_PG_PUBLICATION_UNVERIFIED');
    await this.grant(tx,b,b);const commit:LargeTransferCommit={jobId:b.id,requestId:p.requestId,epoch:p.epoch,sha256:b.sha256,commitId:randomUUID()};
    await tx.db.query("UPDATE transfer_authority.claims SET state='APPLIED' WHERE request_id=$1",[p.requestId]);
    await tx.db.query("UPDATE transfer_authority.jobs SET state='COMPLETE',pending_id=NULL,final_receipt=$2,final_commit=$3 WHERE id=$1",[b.id,JSON.stringify(r),JSON.stringify(commit)]);return commit;
  }
  async commitPublished(b:LargeTransferBinding,l:LargeTransferLease,r:LargeTransferFinalReceipt){
    return this.tx(async tx=>{await this.grant(tx,b,b);const j=await this.job(tx,b);this.active(j,l);const pending=await this.pending(tx,j,b);if(!pending||pending.p.epoch!==l.epoch)return deny('TRANSFER_PG_PUBLICATION_UNVERIFIED');return this.finish(tx,b,j,pending.p,r);});
  }
  async recoverPublished(b:LargeTransferBinding,p:LargeTransferIntent){
    return this.tx(async tx=>{const key=await this.grant(tx,b,b),j=await this.job(tx,b);if(j.state!=='COMPLETE')return undefined;
      const r=j.final_receipt as LargeTransferFinalReceipt,c=j.final_commit as LargeTransferCommit;
      if(!r||!c||!receiptMatches(b,p,r)||!verifyNativeTransferReceipt(b,r,key)||c.jobId!==b.id||c.requestId!==p.requestId||c.epoch!==p.epoch||c.sha256!==b.sha256||!uuid.test(c.commitId))return deny('TRANSFER_PG_FINAL_COMMIT_CORRUPT');return {receipt:r,commit:c};});
  }
  async recoverNativeReceipt(b:LargeTransferBinding,p:LargeTransferIntent){
    return this.tx(async tx=>{const key=await this.grant(tx,b,b),j=await this.job(tx,b);this.active(j);const pending=await this.pending(tx,j,b);if(!pending||!sameIntent(pending.p,p)||p.kind!=='publish'||await this.observe(b,p,pending.claim)!=='applied')return undefined;
      const r=await this.config.readNativeReceipt(b,p);if(!r)return undefined;if(!receiptMatches(b,p,r)||!verifyNativeTransferReceipt(b,r,key))return deny('TRANSFER_PG_PUBLICATION_UNVERIFIED');return r;});
  }
  async commitRecoveredPublication(b:LargeTransferBinding,p:LargeTransferIntent,r:LargeTransferFinalReceipt){return this.tx(async tx=>{await this.grant(tx,b,b);const j=await this.job(tx,b);this.active(j);return this.finish(tx,b,j,p,r);});}
  async cancelTransfer(b:LargeTransferBinding,l:LargeTransferLease){
    await this.tx(async tx=>{await this.grant(tx,b,b);const j=await this.job(tx,b);leaseValid(l);if(integer(j.epoch,1)!==l.epoch||j.lease_hash!==sha(l.token)||j.state==='COMPLETE')return deny('TRANSFER_PG_LEASE_FENCED');if(j.state==='CANCELLED')return;await tx.db.query("UPDATE transfer_authority.jobs SET state='CANCELLED' WHERE id=$1",[b.id]);});
  }
}
/** Called INSIDE the existing core revoke transaction's native drain hook.
 * No new lock on authorities: the caller already holds it. Unknown/active
 * transfer claims block a successful drain; real native drain remains required.
 * Do not use as a standalone proof of revoke completion. */
export function composeTransferDrainObserver(config:{pool:DispatchStorePool;authorityId:string;verifyNativeDrain:(request:{ownerId:string;deviceId:string})=>Promise<boolean>}){
  if(!uuid.test(config.authorityId)||typeof config.pool?.connect!=='function'||typeof config.verifyNativeDrain!=='function')return deny('TRANSFER_PG_DRAIN_CONFIG_INVALID');
  return async(request:{ownerId:string;deviceId:string})=>{
    if(!uuid.test(request.ownerId)||!uuid.test(request.deviceId))return false;
    const db=await config.pool.connect();
    try{
      const row=(await db.query("SELECT COUNT(*)::bigint AS n FROM transfer_authority.claims c JOIN transfer_authority.jobs j ON j.id=c.job_id WHERE j.authority_id=$1 AND j.owner_id=$2 AND (j.source_device_id=$3 OR j.target_device_id=$3) AND c.state IN ('ACTIVE','UNKNOWN')",[config.authorityId,request.ownerId,request.deviceId])).rows[0];
      return integer(row?.n)===0&&await config.verifyNativeDrain(request)===true;
    }finally{db.release();}
  };
}
