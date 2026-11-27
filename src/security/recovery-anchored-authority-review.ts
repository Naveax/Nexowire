// REVIEW ONLY. No listener, provider implementation, or runtime imports.
import type {DispatchStoreConnection, DispatchStorePool} from '../agent/postgres-broker-dispatch-authority.js';
import {createHash,verify,type KeyObject} from 'node:crypto';

export type RecoveryPurpose = 'rollback' | 'coordinated-uninstall';
export type Scope = Readonly<{
  authorityId:string; storeId:string; ownerAccountId:string; ownerEpoch:string;
  directoryHead:string; deviceId:string; installationLineageId:string;
  resourceId:string; bootId:string; sessionEpoch:string; generation:string;
  purpose:RecoveryPurpose; transactionSha256:string; authorizationId:string;
  attemptId:string; requestId:string; challenge:string; requestSha256:string;
  bindingSha256:string; envelopeSha256:string; signerSpkiSha256:string;
  deadlineMs:number;
}>;
export type Head = Readonly<{sequence:string; hash:string}>;
export type Transition = Readonly<{kind:'CONSUME'|'TERMINAL'; scope:Scope;
  leaseId:string; previous:Head; next:Head; originalConsume?:Head; terminal?:Readonly<{outcome:'APPLIED'|'NO_EFFECT'; evidenceSha256:string}>; operator?:Readonly<{ownerAccountId:string;ownerEpoch:string;directoryHead:string}>}>;
// Exact, independently authenticated participant receipts. All relevant writers
// must be fenced or permanently drained; no implicit waiver for missing paths.
const writers=['PRELOGIN_AGENT','NATIVE_AGENT','SYSTEM_HUB','BROKER','HELPER_RUNTIME',
  'HELPER_DEPLOYMENT','MANUAL','SCHEDULER_FORWARD','SCHEDULER_RELEASE','TRANSFER_SOURCE',
  'TRANSFER_TARGET','CORE_WRITER','OWNER_DIRECTORY'] as const;
type Writer=typeof writers[number];
type WriterFence=Readonly<{authorityId:string;storeId:string;deviceId:string;installationLineageId:string;
  resourceId:string;bootId:string;generation:string;directoryHead:string;head:Head;nativeFenceSha256:string;
  expiresMs:number;participants:readonly Readonly<{writer:Writer;state:'FENCED'|'DRAINED';evidenceSha256:string}>[]}>;
// Production implementations MUST authenticate exact bytes and validate independent
// directory, signer inventory, custody, evidence and native fence; no boolean-only
// provenance shim and no default implementation. External CAS also compares
// current owner directory head and atomically rejects stale generation/scope.
export interface IndependentRecoveryBoundary {
  admit(raw:Uint8Array):Promise<Scope>;
  // Must use bounded I/O and finish all access to db before returning/throwing.
  verifyLocked(db:DispatchStoreConnection, scope:Scope, head:Head):Promise<WriterFence>;
  // Durable, restore-external pending reservation before any SQL staging or
  // append. Persist exact transition and deny new admission even on lost reply.
  // A terminal may replace only its exact already consumed original pending.
  // Prepare does not advance the committed witness head or issue permission.
  preparePending(t:Transition):Promise<Readonly<{transitionSha256:string;state:'PENDING'}>>;
  // Provider atomically compares owner directory head, original resource generation
  // and previous head; records durable pending transition before replying. A
  // terminal append compares separately authenticated CURRENT operator epoch.
  compareAndAppend(t:Transition):Promise<Readonly<{head:Head; transitionKind:Transition['kind']; leaseId:string; directoryHead:string}>>;
  // Must persist freeze outside PG backup domain. A failed freeze RPC never
  // licenses retry: provider must deny pending/unresolved attempts on admission.
  freezeUnknown(t:Transition,reason:string):Promise<void>;
  verifyTerminalLocked(db:DispatchStoreConnection, original:Transition, terminal:NonNullable<Transition['terminal']>, operatorEvidence:Uint8Array):Promise<NonNullable<Transition['operator']>>; // independently authenticate current operator and original native drain
  readback(t:Transition):Promise<void>; // independent head + exact DB commit + current owner/fence
}
export type EffectAck = Readonly<{domain:'nexowire.recovery.consume-ack.v1'; scope:Scope;
  leaseId:string; head:Head; state:'CONSUMED'; issuedMs:number; expiresMs:number}>;
export interface RecoveryAckBoundary {
  // Separate recovery key, exact signed bytes, independently enrolled SPKI.
  signCommitted(ack:EffectAck):Promise<Uint8Array>;
  verifyForNativeEffect(bytes:Uint8Array, expected:EffectAck):Promise<void>;
}
const hex=/^[0-9a-f]{64}$/;
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
  return value;
}
function canonicalJson(value:unknown):string{return JSON.stringify(canonical(value));}
function sameExact(a:unknown,b:unknown){return canonicalJson(a)===canonicalJson(b);}
function transitionDigest(t:Transition){return createHash('sha256').update(canonicalJson(['nexowire.lifecycle.pending.v1',t])).digest('hex');}
function verifyWriterFence(f:WriterFence,s:Scope,head:Head,now:number){
  if(!f||f.authorityId!==s.authorityId||f.storeId!==s.storeId||f.deviceId!==s.deviceId||
     f.installationLineageId!==s.installationLineageId||f.resourceId!==s.resourceId||f.bootId!==s.bootId||
     f.generation!==s.generation||f.directoryHead!==s.directoryHead||!sameExact(f.head,head)||
     !hex.test(f.nativeFenceSha256)||!Number.isSafeInteger(f.expiresMs)||f.expiresMs<=now||
     f.expiresMs>s.deadlineMs||!Array.isArray(f.participants)||f.participants.length!==writers.length||
     new Set(f.participants.map(x=>x.writer)).size!==writers.length||
     f.participants.some(x=>!writers.includes(x.writer)||!['FENCED','DRAINED'].includes(x.state)||!hex.test(x.evidenceSha256)))
    throw Error('LIFECYCLE_WRITER_FENCE_INCOMPLETE');
}
async function prepareExact(trust:IndependentRecoveryBoundary,t:Transition){
  const receipt=await bounded(()=>trust.preparePending(t));
  if(receipt?.state!=='PENDING'||receipt.transitionSha256!==transitionDigest(t))throw Error('WITNESS_PENDING_RECEIPT_MISMATCH');
}
function nextHead(previous:Head, body:unknown):Head {
  if(!hex.test(previous.hash)||!/^(0|[1-9][0-9]*)$/.test(previous.sequence))throw Error('ANCHOR_INVALID');
  const sequence=(BigInt(previous.sequence)+1n).toString();
  const hash=createHash('sha256').update(canonicalJson(['nexowire.lifecycle.transition.v1',previous.sequence,previous.hash,sequence,body])).digest('hex');
  return Object.freeze({sequence,hash});
}
// A timeout is ambiguous, not proof of non-execution. A real provider must
// implement durable pending/late-arrival fencing in its own restore domain.
async function bounded<T>(call:()=>Promise<T>,ms=4000):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve().then(call),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('RECOVERY_BOUNDARY_TIMEOUT')),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}
async function appendExact(trust:IndependentRecoveryBoundary,t:Transition){
  const receipt=await bounded(()=>trust.compareAndAppend(t));
  if(receipt?.transitionKind!==t.kind||receipt.leaseId!==t.leaseId||canonicalJson(receipt.head)!==canonicalJson(t.next)||
     receipt.directoryHead!==(t.kind==='CONSUME'?t.scope.directoryHead:t.operator?.directoryHead))throw Error('WITNESS_RECEIPT_MISMATCH');
}
async function freeze(trust:IndependentRecoveryBoundary,t:Transition,reason:string):Promise<never>{
  try{await bounded(()=>trust.freezeUnknown(t,reason));}catch{throw Error('LIFECYCLE_UNKNOWN_FREEZE_UNCONFIRMED');}
  throw Error('LIFECYCLE_UNKNOWN_FREEZE_REQUIRED');
}
// Exact bytes signed with the independently pinned recovery ACK key. This
// verifier cannot authorize effect without the separate native live fence.
function verifyExactAck(bytes:Uint8Array,signature:Uint8Array,key:KeyObject,pin:string,expected:EffectAck,now:number){
  if(key.type!=='public'||key.asymmetricKeyType!=='ed25519'||
     createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex')!==pin||
     !Buffer.from(bytes).equals(Buffer.from(canonicalJson(expected)))||
     !verify(null,bytes,key,signature)||!Number.isSafeInteger(now)||now<expected.issuedMs||now>=expected.expiresMs||
     expected.expiresMs>expected.scope.deadlineMs||expected.expiresMs-expected.issuedMs>30000)
    throw Error('RECOVERY_ACK_DENIED');
}
// Internal transaction sketch: no exported factory, no signed effect ACK.
// Scope object must be validated/canonicalized and frozen by admission boundary.
async function stageConsume(pool:DispatchStorePool, trust:IndependentRecoveryBoundary, scope:Scope, leaseId:string):Promise<Transition> {
  scope=Object.freeze({...scope});
  const db=await pool.connect();let begun=false,anchorAttempted=false,committing=false,destroy=false;let transition:Transition|undefined;let releasedConnection=false;
  try {
    await db.query('BEGIN');begun=true;
    await db.query("SET LOCAL synchronous_commit='on'");
    await db.query("SET LOCAL statement_timeout='5000ms'");
    await db.query("SET LOCAL lock_timeout='3000ms'");
    const a=(await db.query('SELECT * FROM helper_selection.lock_recovery_anchor($1)',[scope.authorityId])).rows[0];
    if(!a||a.lifecycle_store_id!==scope.storeId||a.lifecycle_sequence==null||typeof a.lifecycle_head!=='string')throw Error('ANCHOR_NOT_PROVISIONED');
    const previous=Object.freeze({sequence:String(a.lifecycle_sequence),hash:a.lifecycle_head});
    // This includes role/durability guard, canonical device mapping, current
    // generation, external head, credential lock, all-writer fence and no
    // outstanding CORE/transfer/native operation. Missing support MUST throw.
    const coverage=await trust.verifyLocked(db,scope,previous);
    const occupied=await db.query("SELECT id FROM helper_selection.leases WHERE authority_id=$1 AND device_id=$2 AND state<>'RELEASED'",[scope.authorityId,scope.deviceId]);
    if(occupied.rows.length)throw Error('LIFECYCLE_OCCUPIED');
    const now=Number((await db.query('SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS ms')).rows[0]?.ms);
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(scope.deadlineMs)||scope.deadlineMs<=now||scope.deadlineMs-now>30000)throw Error('RECOVERY_DEADLINE_INVALID');
    verifyWriterFence(coverage,scope,previous,now);
    const next=nextHead(previous,['CONSUME',scope,leaseId]);
    const t:Transition=Object.freeze({kind:'CONSUME',scope,leaseId,previous,next});
    transition=t;
    anchorAttempted=true;await prepareExact(trust,t);
    const row=(await db.query('SELECT helper_selection.stage_recovery_consume($1::jsonb,$2,$3,$4,$5) AS id',[JSON.stringify(scope),leaseId,previous.sequence,previous.hash,next.hash])).rows[0];
    if(row?.id!==leaseId)throw Error('LIFECYCLE_REPLAY_OR_CONFLICT');
    await appendExact(trust,t);
    committing=true;await db.query('COMMIT');begun=false;committing=false;
    releasedConnection=true;db.release(false);
    await bounded(()=>trust.readback(t)); // mismatch is UNKNOWN, never return an effect permit
    committedFresh.add(t);return t;
  } catch(e) {
    if(committing){destroy=true;} else if(begun){try{await db.query('ROLLBACK');}catch{destroy=true;}}
    if(anchorAttempted&&transition){if(!releasedConnection){releasedConnection=true;db.release(destroy);}begun=false;return await freeze(trust,transition,'TRANSACTION_OR_READBACK_UNKNOWN');}
    throw e;
  } finally {if(!releasedConnection)db.release(destroy);}
}
// Terminal transition is status-only. Caller cannot substitute a new scope:
// the original authenticated scope is compared against the immutable row.
async function stageTerminal(pool:DispatchStorePool, trust:IndependentRecoveryBoundary, original:Transition,
  terminal:NonNullable<Transition['terminal']>, operatorEvidence:Uint8Array):Promise<void>{
  if(original.kind!=='CONSUME'||!hex.test(terminal.evidenceSha256)||!['APPLIED','NO_EFFECT'].includes(terminal.outcome))throw Error('TERMINAL_INPUT_INVALID');
  const scope=original.scope,db=await pool.connect();let begun=false,anchorAttempted=false,committing=false,destroy=false;let transition:Transition|undefined;let releasedConnection=false;
  try{
    await db.query('BEGIN');begun=true;
    await db.query("SET LOCAL synchronous_commit='on'");
    await db.query("SET LOCAL statement_timeout='5000ms'");
    await db.query("SET LOCAL lock_timeout='3000ms'");
    const a=(await db.query('SELECT * FROM helper_selection.lock_recovery_anchor($1)',[scope.authorityId])).rows[0];
    if(!a||a.lifecycle_store_id!==scope.storeId||a.lifecycle_sequence==null||typeof a.lifecycle_head!=='string')throw Error('ANCHOR_NOT_PROVISIONED');
    const previous=Object.freeze({sequence:String(a.lifecycle_sequence),hash:a.lifecycle_head});
    const row=(await db.query("SELECT * FROM helper_selection.leases WHERE id=$1 AND authority_id=$2 AND device_id=$3 AND kind='RECOVERY'",[original.leaseId,scope.authorityId,scope.deviceId])).rows[0];
    if(!row||row.state!=='ACTIVE'||row.consume_head!==original.next.hash||String(row.consume_sequence)!==original.next.sequence||canonicalJson(row.lifecycle_scope)!==canonicalJson(scope))throw Error('TERMINAL_ORIGINAL_SCOPE_INVALID');
    const operator=Object.freeze({...await trust.verifyTerminalLocked(db,original,terminal,operatorEvidence)});
    if(!operator.ownerAccountId||!operator.ownerEpoch||!hex.test(operator.directoryHead))throw Error('TERMINAL_OPERATOR_INVALID');
    const next=nextHead(previous,['TERMINAL',scope,original.leaseId,original.next,terminal,operator]);
    const t:Transition=Object.freeze({kind:'TERMINAL',scope,leaseId:original.leaseId,previous,next,originalConsume:original.next,terminal,operator});
    // Verifies role, external head, current owner directory, independent native
    // observation, permanent drain, and signed terminal evidence. The original
    // owner epoch remains immutable; current authorized operator is separate.
    transition=t;
    anchorAttempted=true;await prepareExact(trust,t);
    const released=(await db.query('SELECT helper_selection.stage_recovery_terminal($1::jsonb,$2,$3,$4,$5,$6,$7,$8,$9) AS id',[JSON.stringify(scope),t.leaseId,original.next.sequence,original.next.hash,previous.sequence,previous.hash,next.hash,terminal.outcome,terminal.evidenceSha256])).rows[0];
    if(released?.id!==t.leaseId)throw Error('TERMINAL_CAS_FAILED');
    await appendExact(trust,t);
    committing=true;await db.query('COMMIT');begun=false;committing=false;
    releasedConnection=true;db.release(false);
    await bounded(()=>trust.readback(t)); // status only; never mint a new grant here
  }catch(e){
    if(committing){destroy=true;}else if(begun){try{await db.query('ROLLBACK');}catch{destroy=true;}}
    if(anchorAttempted&&transition){if(!releasedConnection){releasedConnection=true;db.release(destroy);}begun=false;return await freeze(trust,transition,'TRANSACTION_OR_READBACK_UNKNOWN');}
    throw e;
  }finally{if(!releasedConnection)db.release(destroy);}
}
// Explicit operator reconciliation against the exact durable, frozen external
// head. The independently authenticated proof is not supplied by an Agent.
// The witness boundary authenticates enrollment, signed history, current
// operator, durable freeze and native drain for a TERMINAL reconstruction.
// It MUST NOT thaw the authority or issue a new effect on readback.
interface FrozenWitnessBoundary extends IndependentRecoveryBoundary {
  readFrozenLocked(db:DispatchStoreConnection,authorityId:string,storeId:string,
    local:Head,operatorEvidence:Uint8Array):Promise<Readonly<{state:'FROZEN';head:Head;transition:Transition}>>;
  readbackFrozen(t:Transition):Promise<void>;
}
function validateHistorical(t:Transition,authorityId:string,storeId:string,external:Head){
  if(!t||t.scope.authorityId!==authorityId||t.scope.storeId!==storeId||!sameExact(t.next,external))
    throw Error('WITNESS_HISTORY_SCOPE_DENIED');
  const body=t.kind==='CONSUME'&&!t.terminal&&!t.operator&&!t.originalConsume?['CONSUME',t.scope,t.leaseId]:
    t.kind==='TERMINAL'&&t.terminal&&t.operator&&t.originalConsume?['TERMINAL',t.scope,t.leaseId,t.originalConsume,t.terminal,t.operator]:undefined;
  if(!body||!sameExact(nextHead(t.previous,body),t.next))throw Error('WITNESS_HISTORY_CHAIN_DENIED');
}
function exactHistoricalRow(row:Record<string,unknown>|undefined,t:Transition){
  if(!row||row.id!==t.leaseId||!sameExact(row.lifecycle_scope,t.scope))return false;
  const consumed=t.kind==='CONSUME'?t.next:t.originalConsume;
  if(!consumed||String(row.consume_sequence)!==consumed.sequence||row.consume_head!==consumed.hash)return false;
  return t.kind==='CONSUME'?row.state==='ACTIVE':row.state==='RELEASED'&&String(row.terminal_sequence)===t.next.sequence&&
    row.terminal_head===t.next.hash&&row.terminal_outcome===t.terminal?.outcome&&row.terminal_evidence_sha256===t.terminal?.evidenceSha256;
}
async function reconstructWitnessAhead(pool:DispatchStorePool,trust:FrozenWitnessBoundary,
  authorityId:string,storeId:string,operatorEvidence:Uint8Array):Promise<'FROZEN_RECONSTRUCTED'|'FROZEN_ALREADY_PRESENT'>{
  const db=await pool.connect();let begun=false,committing=false,destroy=false,released=false;
  try{
    await db.query('BEGIN');begun=true;
    await db.query("SET LOCAL synchronous_commit='on'");
    await db.query("SET LOCAL statement_timeout='5000ms'");
    await db.query("SET LOCAL lock_timeout='3000ms'");
    const a=(await db.query('SELECT * FROM helper_selection.lock_recovery_anchor($1)',[authorityId])).rows[0];
    if(!a||a.lifecycle_store_id!==storeId||a.lifecycle_sequence==null||typeof a.lifecycle_head!=='string')throw Error('ANCHOR_NOT_PROVISIONED');
    const local=Object.freeze({sequence:String(a.lifecycle_sequence),hash:a.lifecycle_head});
    const proof=await trust.readFrozenLocked(db,authorityId,storeId,local,operatorEvidence);
    if(proof?.state!=='FROZEN')throw Error('WITNESS_NOT_FROZEN');
    // Snapshot verified data before use; never let a mutable adapter swap it.
    const t=JSON.parse(canonicalJson(proof.transition)) as Transition;
    validateHistorical(t,authorityId,storeId,proof.head);
    const row=async()=>(await db.query("SELECT * FROM helper_selection.leases WHERE id=$1 AND authority_id=$2 AND device_id=$3 AND kind='RECOVERY'",[t.leaseId,authorityId,t.scope.deviceId])).rows[0];
    let status:'FROZEN_RECONSTRUCTED'|'FROZEN_ALREADY_PRESENT';
    if(sameExact(local,t.next)){
      if(!exactHistoricalRow(await row(),t))throw Error('WITNESS_LOCAL_ROW_DIVERGENCE');
      status='FROZEN_ALREADY_PRESENT';
    }else{
      // No multi-step replay or rollback of a divergent head. Repair only one
      // exact witnessed next transition; all other cases remain frozen.
      if(!sameExact(local,t.previous))throw Error('WITNESS_LOCAL_HEAD_DIVERGENCE');
      const v=t.kind==='CONSUME'?
        await db.query('SELECT helper_selection.restore_recovery_consume($1::jsonb,$2,$3,$4,$5) AS id',[JSON.stringify(t.scope),t.leaseId,t.previous.sequence,t.previous.hash,t.next.hash]):
        await db.query('SELECT helper_selection.stage_recovery_terminal($1::jsonb,$2,$3,$4,$5,$6,$7,$8,$9) AS id',[JSON.stringify(t.scope),t.leaseId,t.originalConsume!.sequence,t.originalConsume!.hash,t.previous.sequence,t.previous.hash,t.next.hash,t.terminal!.outcome,t.terminal!.evidenceSha256]);
      if(v.rows[0]?.id!==t.leaseId||!exactHistoricalRow(await row(),t))throw Error('WITNESS_RECONSTRUCTION_ROW_DENIED');
      status='FROZEN_RECONSTRUCTED';
    }
    committing=true;await db.query('COMMIT');begun=false;committing=false;
    released=true;db.release(false);
    await bounded(()=>trust.readbackFrozen(t));
    // Deliberately no committedFresh.add(), append, signer, or thaw.
    return status;
  }catch(e){if(committing)destroy=true;else if(begun){try{await db.query('ROLLBACK');}catch{destroy=true;}}throw e;}
  finally{if(!released)db.release(destroy);}
}
// ACK construction is only for the original, just-committed transition. No
// historical lookup or duplicate request may call this. The external boundary
// must recheck current owner and native fence; the recipient verifies again.
const committedFresh=new WeakSet<Transition>();
const freshAckAttempts=new WeakSet<Transition>();
async function signFreshConsume(t:Transition,trust:IndependentRecoveryBoundary,signer:RecoveryAckBoundary):Promise<Uint8Array>{
  if(t.kind!=='CONSUME'||!committedFresh.has(t)||freshAckAttempts.has(t))throw Error('ACK_PURPOSE_OR_REPLAY_INVALID');
  freshAckAttempts.add(t);committedFresh.delete(t);
  try{
    await bounded(()=>trust.readback(t));
    const issuedMs=Date.now(),expiresMs=Math.min(t.scope.deadlineMs,issuedMs+30000);
    if(expiresMs<=issuedMs)throw Error('ACK_EXPIRED');
    const ack:EffectAck=Object.freeze({domain:'nexowire.recovery.consume-ack.v1',scope:t.scope,leaseId:t.leaseId,head:t.next,state:'CONSUMED',issuedMs,expiresMs});
    const signed=await bounded(()=>signer.signCommitted(ack));
    await bounded(()=>signer.verifyForNativeEffect(signed,ack));
    await bounded(()=>trust.readback(t));
    if(Date.now()>=expiresMs)throw Error('ACK_EXPIRED');
    return signed;
  }catch{return await freeze(trust,t,'ACK_UNKNOWN');}
}
// Deliberate hard stop: no runtime factory, route or positive provider exported.
// These functions are review sketches, not a deployable boundary. In particular,
// actual independently durable witness and signer are not provisioned here.
void stageConsume;void stageTerminal;void signFreshConsume;void verifyExactAck;void reconstructWitnessAhead;
export function independentRecoveryUnavailable():never {
  throw Error('RECOVERY_INDEPENDENT_PROVIDER_NOT_PROVISIONED');
}
