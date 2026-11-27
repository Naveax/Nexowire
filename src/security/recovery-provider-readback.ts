// Protected-service readback adapter for the existing V3 authority. No grant
// issuer, signing key, migration, listener, or effect entrypoint is exported.
import {createHash,createPublicKey,randomBytes,verify,X509Certificate} from 'node:crypto';
import {request} from 'node:https';
import {checkServerIdentity} from 'node:tls';
import type {DispatchStoreConnection,DispatchStorePool} from '../agent/postgres-broker-dispatch-authority.js';
import type {Head,Scope,Transition,IndependentRecoveryBoundary} from './recovery-anchored-authority-review.js';

const DOMAIN='nexowire.lifecycle.witness.readback.v1';
const hex=/^[0-9a-f]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const seq=/^(0|[1-9][0-9]{0,18})$/;
const deny=(code:string):never=>{throw Error(code);};
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v!==null&&typeof v==='object'?
  Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;
const json=(v:unknown)=>JSON.stringify(canonical(v));
const exact=(a:unknown,b:unknown)=>json(a)===json(b);
const record=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:deny('WITNESS_READBACK_FORMAT');
const keys=(v:Record<string,unknown>,names:string[])=>{if(!exact(Object.keys(v).sort(),names.sort()))deny('WITNESS_READBACK_FORMAT');};
function head(v:unknown):Head{
  const r=record(v);keys(r,['sequence','hash']);
  if(typeof r.sequence!=='string'||!seq.test(r.sequence)||BigInt(r.sequence)>9223372036854775807n||typeof r.hash!=='string'||!hex.test(r.hash))return deny('WITNESS_READBACK_HEAD_INVALID');
  return {sequence:r.sequence,hash:r.hash};
}
export interface RecoveryWitnessReadbackConfig {
  authorityId:string;storeId:string;endpoint:string;
  caPem:string;clientCertificatePem:string;clientKeyPem:string;
  serverSpkiSha256:string;witnessPublicKeyPem:string;witnessSpkiSha256:string;
  // Independently provisioned, NOT supplied by the caller of readback().
  recoveryAckSpkiSha256:string;
  timeoutMs?:number;
}
interface SnapshotRequest {authorityId:string;storeId:string;action:'READBACK';nonce:string;domain:typeof DOMAIN;}
interface Snapshot {authorityId:string;storeId:string;head:Head|null;state:'UNANCHORED'|'PENDING'|'FROZEN'|'COMMITTED';transitionSha256:string|null;ownerAccountId:string|null;ownerEpoch:string|null;directoryHead:string;issuedMs:number;expiresMs:number;}
/** Signed, request-bound snapshot from the independently operated witness.
 * The witness must derive current state from its own durable history, never
 * from caller-supplied head/owner. TLS+signature do not prove restore separation.
 */
export class ProtectedRecoveryWitnessReadback {
  readonly authorityId:string;readonly storeId:string;
  private readonly config:Readonly<RecoveryWitnessReadbackConfig>;
  private readonly url:URL;private readonly key:ReturnType<typeof createPublicKey>;
  private readonly timeout:number;
  constructor(config:RecoveryWitnessReadbackConfig){
    const c=Object.freeze({...config});
    if(!uuid.test(c.authorityId)||!uuid.test(c.storeId)||!hex.test(c.serverSpkiSha256)||!hex.test(c.witnessSpkiSha256)||
      !hex.test(c.recoveryAckSpkiSha256)||new Set([c.serverSpkiSha256,c.witnessSpkiSha256,c.recoveryAckSpkiSha256]).size!==3||
      !c.caPem.includes('-----BEGIN CERTIFICATE-----')||!c.clientCertificatePem.includes('-----BEGIN CERTIFICATE-----')||!c.clientKeyPem.includes('PRIVATE KEY-----'))deny('WITNESS_READBACK_CONFIG_INVALID');
    this.url=new URL(c.endpoint);if(this.url.protocol!=='https:'||this.url.username||this.url.password||this.url.hash||this.url.search||this.url.pathname!=='/v1/lifecycle/readback')deny('WITNESS_READBACK_ENDPOINT_INVALID');
    this.key=createPublicKey(c.witnessPublicKeyPem);
    if(this.key.asymmetricKeyType!=='ed25519'||sha(this.key.export({format:'der',type:'spki'}))!==c.witnessSpkiSha256)deny('WITNESS_READBACK_SIGNER_INVALID');
    this.timeout=c.timeoutMs??2500;if(!Number.isSafeInteger(this.timeout)||this.timeout<100||this.timeout>3000)deny('WITNESS_READBACK_TIMEOUT_INVALID');
    this.authorityId=c.authorityId;this.storeId=c.storeId;this.config=c;
  }
  async current():Promise<Readonly<Snapshot>>{
    const req:SnapshotRequest={authorityId:this.authorityId,storeId:this.storeId,action:'READBACK',nonce:randomBytes(32).toString('hex'),domain:DOMAIN};
    const raw=Buffer.from(json(req));const started=process.hrtime.bigint();const c=this.config;
    const envelope=await new Promise<Buffer>((resolve,reject)=>{
      let settled=false;let timer:ReturnType<typeof setTimeout>|undefined;
      const finish=(error:Error|undefined,value?:Buffer)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);if(error)reject(error);else resolve(value!);};
      const http=request(this.url,{method:'POST',agent:false,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',rejectUnauthorized:true,
        ca:c.caPem,cert:c.clientCertificatePem,key:c.clientKeyPem,
        checkServerIdentity(host,cert){const err=checkServerIdentity(host,cert);if(err)return err;
          try{if(!cert.raw||sha(new X509Certificate(cert.raw).publicKey.export({format:'der',type:'spki'}))!==c.serverSpkiSha256)return Error('WITNESS_TLS_PIN_MISMATCH');}catch{return Error('WITNESS_TLS_PIN_MISMATCH');}},
        headers:{'content-type':'application/json','content-length':raw.length,'connection':'close'}},res=>{
          if(res.statusCode!==200||res.headers['content-type']!=='application/json'||res.headers['transfer-encoding']||res.headers['content-encoding']){res.destroy();finish(Error('WITNESS_READBACK_HTTP_DENIED'));return;}
          const size=Number(res.headers['content-length']);if(!Number.isSafeInteger(size)||size<1||size>32768){res.destroy();finish(Error('WITNESS_READBACK_SIZE_DENIED'));return;}
          const parts:Buffer[]=[];let received=0;
          res.on('data',(chunk:Buffer)=>{received+=chunk.length;if(received>size){res.destroy();finish(Error('WITNESS_READBACK_SIZE_DENIED'));}else parts.push(chunk);});
          res.once('aborted',()=>finish(Error('WITNESS_READBACK_UNKNOWN')));res.once('error',()=>finish(Error('WITNESS_READBACK_UNKNOWN')));
          res.once('end',()=>{if(!res.complete||received!==size)finish(Error('WITNESS_READBACK_UNKNOWN'));else finish(undefined,Buffer.concat(parts));});
        });
      http.once('error',()=>finish(Error('WITNESS_READBACK_UNKNOWN')));
      timer=setTimeout(()=>{http.destroy();finish(Error('WITNESS_READBACK_UNKNOWN'));},this.timeout);http.end(raw);
    });
    const e=record(JSON.parse(envelope.toString('utf8')));keys(e,['payload','signature']);
    if(typeof e.payload!=='string'||typeof e.signature!=='string'||! /^[A-Za-z0-9_-]{86}$/.test(e.signature)||! /^[A-Za-z0-9_-]+$/.test(e.payload))return deny('WITNESS_READBACK_FORMAT');
    const bytes=Buffer.from(e.payload,'base64url');const sig=Buffer.from(e.signature,'base64url');
    if(bytes.toString('base64url')!==e.payload||sig.toString('base64url')!==e.signature||sig.length!==64||!verify(null,bytes,this.key,sig))return deny('WITNESS_READBACK_SIGNATURE_DENIED');
    const p=record(JSON.parse(bytes.toString('utf8')));keys(p,['domain','nonce','requestSha256','snapshot']);
    if(!bytes.equals(Buffer.from(json(p)))||p.domain!==DOMAIN||p.nonce!==req.nonce||p.requestSha256!==sha(raw))return deny('WITNESS_READBACK_BINDING_DENIED');
    const s=record(p.snapshot);keys(s,['authorityId','storeId','head','state','transitionSha256','ownerAccountId','ownerEpoch','directoryHead','issuedMs','expiresMs']);
    const now=Date.now();
    if(s.authorityId!==this.authorityId||s.storeId!==this.storeId||!['UNANCHORED','PENDING','FROZEN','COMMITTED'].includes(String(s.state))||
      typeof s.directoryHead!=='string'||!hex.test(s.directoryHead)||typeof s.issuedMs!=='number'||typeof s.expiresMs!=='number'||
      !Number.isSafeInteger(s.issuedMs)||!Number.isSafeInteger(s.expiresMs)||s.issuedMs>now||s.expiresMs<=now||s.expiresMs-s.issuedMs>5000||
      process.hrtime.bigint()-started>=BigInt(this.timeout)*1000000n)return deny('WITNESS_READBACK_SCOPE_OR_FRESHNESS_DENIED');
    if(s.state==='UNANCHORED'){
      if(s.head!==null||s.transitionSha256!==null||s.ownerAccountId!==null||s.ownerEpoch!==null)return deny('WITNESS_READBACK_FORMAT');
    }else{
      head(s.head);
      if(typeof s.transitionSha256!=='string'||!hex.test(s.transitionSha256)||typeof s.ownerAccountId!=='string'||!uuid.test(s.ownerAccountId)||typeof s.ownerEpoch!=='string'||!seq.test(s.ownerEpoch)||s.ownerEpoch==='0')return deny('WITNESS_READBACK_FORMAT');
    }
    return Object.freeze({...s,head:s.head===null?null:Object.freeze(head(s.head))}) as unknown as Readonly<Snapshot>;
  }
}
function assertScope(s:Scope,w:ProtectedRecoveryWitnessReadback){
  if(s.authorityId!==w.authorityId||s.storeId!==w.storeId||!uuid.test(s.deviceId)||!uuid.test(s.ownerAccountId)||!hex.test(s.directoryHead)||!seq.test(s.ownerEpoch)||s.ownerEpoch==='0')deny('RECOVERY_READBACK_SCOPE_DENIED');
}
/** Invoke on the SAME existing transaction, before any legacy observer or
 * effect-producing READ. Caller must retain lock through its transaction.
 * Both DB and independent directory/witness must attest UNANCHORED; a stale
 * backup with no anchor or a missing migration cannot silently re-enable it.
 * This is a quarantine gate, not a general writer permission or migration.
 */
export async function assertLegacyAdmissionLocked(db:DispatchStoreConnection,w:ProtectedRecoveryWitnessReadback):Promise<void>{
  const a=(await db.query('SELECT lifecycle_store_id,lifecycle_sequence,lifecycle_head FROM core_dispatch.authorities WHERE authority_id=$1 FOR UPDATE',[w.authorityId])).rows;
  const local=a[0];if(a.length!==1||!local||local.lifecycle_store_id!==null||local.lifecycle_sequence!==null||local.lifecycle_head!==null)return deny('LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED');
  const s=await w.current();if(s.state!=='UNANCHORED')return deny('LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED');
}
/** Concrete readback implementation for the existing V3 boundary. It accepts
 * no signer or effect callback, returns no permit, and MUST be combined with
 * V3 fresh-consume, independent admission, native-fence and signer gates.
 */
export function createRecoveryCommitReadback(pool:DispatchStorePool,w:ProtectedRecoveryWitnessReadback):Pick<IndependentRecoveryBoundary,'readback'>{
  return Object.freeze({async readback(input:Transition):Promise<void>{
    // Copy the immutable reviewed representation before the first await.
    const t=JSON.parse(json(input)) as Transition;assertScope(t.scope,w);
    if(!uuid.test(t.leaseId)||!['CONSUME','TERMINAL'].includes(t.kind))deny('RECOVERY_READBACK_SCOPE_DENIED');
    head(t.previous);head(t.next);
    const body=t.kind==='CONSUME'?['CONSUME',t.scope,t.leaseId]:['TERMINAL',t.scope,t.leaseId,t.originalConsume,t.terminal,t.operator];
    if(BigInt(t.next.sequence)!==BigInt(t.previous.sequence)+1n||t.next.hash!==sha(json(['nexowire.lifecycle.transition.v1',t.previous.sequence,t.previous.hash,t.next.sequence,body])))deny('RECOVERY_READBACK_TRANSITION_DENIED');
    const db=await pool.connect();let active=false,committing=false,destroy=false;
    try{
      await db.query('BEGIN');active=true;
      await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await db.query("SET LOCAL statement_timeout='3000ms'");await db.query("SET LOCAL lock_timeout='2000ms'");
      const a=(await db.query('SELECT * FROM helper_selection.lock_recovery_anchor($1)',[w.authorityId])).rows;
      const local=a[0];if(a.length!==1||!local||local.lifecycle_store_id!==w.storeId||String(local.lifecycle_sequence)!==t.next.sequence||local.lifecycle_head!==t.next.hash)deny('RECOVERY_READBACK_DB_HEAD_DIVERGED');
      const row=(await db.query("SELECT * FROM helper_selection.leases WHERE id=$1 AND authority_id=$2 AND device_id=$3 AND kind='RECOVERY'",[t.leaseId,w.authorityId,t.scope.deviceId])).rows;
      const original=t.kind==='CONSUME'?t.next:t.originalConsume;
      const stored=row[0];if(row.length!==1||!stored||!original||!exact(stored.lifecycle_scope,t.scope)||String(stored.consume_sequence)!==original.sequence||stored.consume_head!==original.hash||
        (t.kind==='CONSUME'?stored.state!=='ACTIVE':stored.state!=='RELEASED'||String(stored.terminal_sequence)!==t.next.sequence||stored.terminal_head!==t.next.hash||stored.terminal_outcome!==t.terminal?.outcome||stored.terminal_evidence_sha256!==t.terminal?.evidenceSha256))deny('RECOVERY_READBACK_ROW_DIVERGED');
      const external=await w.current();const operator=t.kind==='CONSUME'?t.scope:t.operator;
      if(external.state!=='COMMITTED'||!exact(external.head,t.next)||external.transitionSha256!==sha(json(['nexowire.lifecycle.pending.v1',t]))||!operator||external.ownerAccountId!==operator.ownerAccountId||external.ownerEpoch!==operator.ownerEpoch||external.directoryHead!==operator.directoryHead)deny('RECOVERY_READBACK_WITNESS_DIVERGED');
      if(t.kind==='CONSUME'&&(!Number.isSafeInteger(t.scope.deadlineMs)||Date.now()>=t.scope.deadlineMs))deny('RECOVERY_READBACK_EXPIRED');
      committing=true;await db.query('COMMIT');active=false;committing=false;
      // A commit acknowledgement is status, never an effect authorization.
    }catch(error){if(committing)destroy=true;else if(active)try{await db.query('ROLLBACK');}catch{destroy=true;}throw error;}
    finally{db.release(destroy);}
  }});
}
