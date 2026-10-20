import type {DatabaseSync} from 'node:sqlite';

/**
 * STAGING ONLY. Independent resource-admission ledger for issue #588.
 * NOT hooked into Artifact Bridge, MCP dispatch, billing or production D1.
 * All principal/scope/device/free-space/commit receipts MUST be supplied by
 * a trusted server-side adapter, not client JSON.
 */
export const ARTIFACT_CHUNK_BYTES=65_536;
export interface ArtifactBudgetPolicy {
  globalMinuteBytes:number;
  ownerMinuteBytes:number;
  globalStorageBytes:number;
  ownerStorageBytes:number;
  minFreeDiskBytes:number;
  maxConcurrentGlobal:number;
  maxConcurrentPerOwner:number;
}
export const STAGING_ARTIFACT_BUDGET:Readonly<ArtifactBudgetPolicy>={
  globalMinuteBytes:64*1024*1024,
  ownerMinuteBytes:8*1024*1024,
  globalStorageBytes:8*1024*1024*1024,
  ownerStorageBytes:2*1024*1024*1024,
  minFreeDiskBytes:64*1024*1024,
  maxConcurrentGlobal:16,
  maxConcurrentPerOwner:2,
};
type Phase='OPEN'|'CANCEL_PENDING'|'COMPLETE'|'RELEASED';
export type BudgetDecision=
  | 'RESERVED'|'ALREADY_RESERVED'|'CHUNK_PENDING'|'CHUNK_COMMITTED'
  | 'CHUNK_ALREADY_COMMITTED'|'COMPLETE'|'ALREADY_COMPLETE'|'RELEASED'
  | 'CANCEL_PENDING'|'ALREADY_CANCEL_PENDING'
  | 'DENIED_OWNER'|'DENIED_CAPACITY'|'DENIED_RATE'
  | 'DENIED_CONCURRENCY'|'DENIED_REPLAY'|'DENIED_OFFSET'
  | 'DENIED_PENDING'|'DENIED_STATE';

export interface TrustedArtifactIdentity {
  ownerId:string; deviceId:string; projectId:string;
}
export interface TrustedOpenArtifact extends TrustedArtifactIdentity {
  sessionId:string;rootInvocationId:string;sizeBytes:number;
  sourceSha256:string;physicalFreeBytes:number;now:Date;
}
export interface TrustedArtifactChunk extends TrustedArtifactIdentity {
  sessionId:string;requestId:string;offsetBytes:number;byteCount:number;
  chunkSha256:string;now:Date;
}
export interface TrustedDurableChunkReceipt extends TrustedArtifactIdentity {
  sessionId:string;requestId:string;offsetBytes:number;byteCount:number;
  /** SHA verified against durable store bytes by #08-owned source, not caller. */
  storedSha256:string;durableStorageVerified:true;
}
export interface TrustedDurableFinalReceipt extends TrustedArtifactIdentity {
  sessionId:string;storedSizeBytes:number;storedSha256:string;
  durableStorageVerified:true;
}
export interface TrustedArtifactCancel extends TrustedArtifactIdentity {
  sessionId:string;
  /** CAS fence: the owner verified the current durable logical offset. */
  expectedOffsetBytes:number;
}
export interface TrustedRemovedReceipt extends TrustedArtifactIdentity {
  sessionId:string;durableDeletionVerified:true;
  /** Required before releasing an interrupted/uncertain partial upload. */
  writersStoppedVerified?:true;
}

const idRe=/^[A-Za-z0-9_.:@-]{8,128}$/;
const shaRe=/^[a-f0-9]{64}$/;
const isPositive=(x:number)=>Number.isSafeInteger(x)&&x>0;
function id(x:string,name:string):string {
  if(typeof x!=='string'||!idRe.test(x))throw Error('INVALID_'+name);
  return x;
}
function sha(x:string):string {
  if(typeof x!=='string'||!shaRe.test(x))throw Error('INVALID_SHA256');
  return x;
}
function ms(d:Date):number {
  if(!(d instanceof Date)||!Number.isSafeInteger(d.getTime())||d.getTime()<0)
    throw Error('INVALID_SERVER_CLOCK');
  return d.getTime();
}
function count(x:number,n:string):number {
  if(!Number.isSafeInteger(x)||x<0)throw Error('INVALID_'+n);
  return x;
}
type Row={owner_id:string;device_id:string;project_id:string;
  session_id:string;root_invocation_id:string;size_bytes:number;
  source_sha256:string;offset_bytes:number;state:Phase};
type ChunkRow={owner_id:string;device_id:string;project_id:string;
  session_id:string;request_id:string;offset_bytes:number;
  byte_count:number;chunk_sha256:string;state:'PENDING'|'COMMITTED'};
function subjectMatch(row:Row|ChunkRow,x:TrustedArtifactIdentity):boolean {
  return row.owner_id===x.ownerId&&row.device_id===x.deviceId&&
    row.project_id===x.projectId;
}
function policyValid(p:ArtifactBudgetPolicy):void {
  if(!Object.values(p).every(isPositive) ||
    p.ownerMinuteBytes>Math.floor(p.globalMinuteBytes/4) ||
    p.ownerStorageBytes>Math.floor(p.globalStorageBytes/4) ||
    p.maxConcurrentPerOwner>Math.floor(p.maxConcurrentGlobal/4) ||
    p.globalMinuteBytes>Number.MAX_SAFE_INTEGER ||
    p.globalStorageBytes>Number.MAX_SAFE_INTEGER){
    throw Error('FAIRNESS_POLICY_INVALID');
  }
}
export function initArtifactBudgetFixture(db:DatabaseSync):void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS budget_artifact_sessions ('+
      'session_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,device_id TEXT NOT NULL,'+
      'project_id TEXT NOT NULL,root_invocation_id TEXT NOT NULL,'+
      'size_bytes INTEGER NOT NULL,source_sha256 TEXT NOT NULL,'+
      'offset_bytes INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,'+
      'UNIQUE(owner_id,root_invocation_id));'+
    'CREATE TABLE IF NOT EXISTS budget_artifact_chunks ('+
      'request_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,device_id TEXT NOT NULL,'+
      'project_id TEXT NOT NULL,session_id TEXT NOT NULL,'+
      'offset_bytes INTEGER NOT NULL,byte_count INTEGER NOT NULL,'+
      'chunk_sha256 TEXT NOT NULL,accepted_at_ms INTEGER NOT NULL,'+
      'state TEXT NOT NULL);'+
    'CREATE INDEX IF NOT EXISTS budget_chunk_minute_owner '+
      'ON budget_artifact_chunks(owner_id,accepted_at_ms);'+
    'CREATE TABLE IF NOT EXISTS budget_artifact_clock ('+
      'singleton INTEGER PRIMARY KEY CHECK(singleton=1),last_seen_ms INTEGER NOT NULL);'
  );
}

export class StagingArtifactByteBudget {
  constructor(private readonly db:DatabaseSync,
              private readonly policy:ArtifactBudgetPolicy=STAGING_ARTIFACT_BUDGET){
    policyValid(policy);
  }
  private transaction<T>(work:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try{const out=work();this.db.exec('COMMIT');return out}
    catch(error){try{this.db.exec('ROLLBACK')}catch{}throw error}
  }
  private session(sessionId:string):Row|undefined {
    return this.db.prepare(
      'SELECT * FROM budget_artifact_sessions WHERE session_id=?'
    ).get(sessionId) as Row|undefined;
  }
  private chunk(requestId:string):ChunkRow|undefined {
    return this.db.prepare(
      'SELECT * FROM budget_artifact_chunks WHERE request_id=?'
    ).get(requestId) as ChunkRow|undefined;
  }
  private sum(sql:string,args:unknown[]=[]):number {
    const r=this.db.prepare(sql).get(...args as Parameters<
      ReturnType<DatabaseSync['prepare']>['get']>) as {n:number}|undefined;
    const n=Number(r?.n??0);
    if(!Number.isSafeInteger(n)||n<0)throw Error('BUDGET_COUNTER_CORRUPT');
    return n;
  }
  private trustedClock(t:number):void {
    const prev=this.db.prepare(
      'SELECT last_seen_ms AS n FROM budget_artifact_clock WHERE singleton=1'
    ).get() as {n:number}|undefined;
    if(prev&&prev.n>t)throw Error('BUDGET_CLOCK_ROLLBACK');
    this.db.prepare(
      'INSERT INTO budget_artifact_clock(singleton,last_seen_ms) VALUES(1,?) '+
      'ON CONFLICT(singleton) DO UPDATE SET last_seen_ms=excluded.last_seen_ms'
    ).run(t);
  }
  /** One logical root is registered once. No paid entitlement is granted. */
  begin(x:TrustedOpenArtifact):BudgetDecision {
    id(x.ownerId,'OWNER');id(x.deviceId,'DEVICE');id(x.projectId,'PROJECT');
    id(x.sessionId,'SESSION');id(x.rootInvocationId,'ROOT');sha(x.sourceSha256);
    const size=count(x.sizeBytes,'FILE_SIZE'),free=count(x.physicalFreeBytes,'DISK_FREE');
    const t=ms(x.now);
    return this.transaction(()=>{
      this.trustedClock(t);
      const bySession=this.session(x.sessionId);
      const byRoot=this.db.prepare(
        'SELECT * FROM budget_artifact_sessions WHERE owner_id=? AND root_invocation_id=?'
      ).get(x.ownerId,x.rootInvocationId) as Row|undefined;
      const existed=bySession??byRoot;
      if(existed){
        if(!subjectMatch(existed,x)||existed.session_id!==x.sessionId ||
           existed.root_invocation_id!==x.rootInvocationId ||
           existed.size_bytes!==size||existed.source_sha256!==x.sourceSha256)
          return 'DENIED_REPLAY';
        return existed.state==='OPEN'?'ALREADY_RESERVED':'DENIED_STATE';
      }
      if(size<1)return 'DENIED_CAPACITY';
      const global=this.sum('SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE state<>?', ['RELEASED']);
      const owner=this.sum('SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE state<>? AND owner_id=?',['RELEASED',x.ownerId]);
      if(size>this.policy.ownerStorageBytes-owner ||
         size>this.policy.globalStorageBytes-global ||
         size>free-global-this.policy.minFreeDiskBytes) return 'DENIED_CAPACITY';
      const active=this.sum('SELECT COUNT(*) AS n FROM budget_artifact_sessions WHERE state=?',['OPEN']);
      const ownerActive=this.sum('SELECT COUNT(*) AS n FROM budget_artifact_sessions WHERE state=? AND owner_id=?',['OPEN',x.ownerId]);
      if(active>=this.policy.maxConcurrentGlobal||
         ownerActive>=this.policy.maxConcurrentPerOwner) return 'DENIED_CONCURRENCY';
      this.db.prepare('INSERT INTO budget_artifact_sessions '+
        '(session_id,owner_id,device_id,project_id,root_invocation_id,size_bytes,'+
        'source_sha256,offset_bytes,state) VALUES(?,?,?,?,?,?,?,0,?)'
      ).run(x.sessionId,x.ownerId,x.deviceId,x.projectId,x.rootInvocationId,
        size,x.sourceSha256,'OPEN');
      return 'RESERVED';
    });
  }
  /**
   * Stage byte/transport reservation BEFORE external durable chunk write.
   * PENDING is never automatically retried or refunded; must reconcile
   * with #08's authenticated durable store receipt first.
   */
  stageChunk(x:TrustedArtifactChunk):BudgetDecision {
    id(x.ownerId,'OWNER');id(x.deviceId,'DEVICE');id(x.projectId,'PROJECT');
    id(x.sessionId,'SESSION');id(x.requestId,'REQUEST');sha(x.chunkSha256);
    const offset=count(x.offsetBytes,'OFFSET'),bytes=count(x.byteCount,'BYTES');
    const t=ms(x.now);
    if(!isPositive(bytes)||bytes>ARTIFACT_CHUNK_BYTES)throw Error('CHUNK_SIZE_INVALID');
    return this.transaction(()=>{
      this.trustedClock(t);
      const scoped=this.session(x.sessionId);
      // A tombstoned session must never reopen from a replay.
      if(scoped && subjectMatch(scoped,x) && scoped.state!=='OPEN')
        return 'DENIED_STATE';
      const prev=this.chunk(x.requestId);
      if(prev){
        if(!subjectMatch(prev,x)||prev.session_id!==x.sessionId||
          prev.offset_bytes!==offset||prev.byte_count!==bytes||
          prev.chunk_sha256!==x.chunkSha256)return 'DENIED_REPLAY';
        return prev.state==='COMMITTED'?'CHUNK_ALREADY_COMMITTED':'CHUNK_PENDING';
      }
      const session=this.session(x.sessionId);
      if(!session||!subjectMatch(session,x))return 'DENIED_OWNER';
      if(session.state!=='OPEN')return 'DENIED_STATE';
      if(offset!==session.offset_bytes ||
        bytes>session.size_bytes-offset)return 'DENIED_OFFSET';
      const pending=this.sum(
        'SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE session_id=? AND state=?',
        [x.sessionId,'PENDING']);
      if(pending)return 'DENIED_PENDING';
      const sql='SELECT COALESCE(SUM(byte_count),0) AS n FROM budget_artifact_chunks '+
        'WHERE accepted_at_ms>? AND accepted_at_ms<=?';
      const global=this.sum(sql,[t-60000,t]);
      const own=this.sum(sql+' AND owner_id=?',[t-60000,t,x.ownerId]);
      if(bytes>this.policy.globalMinuteBytes-global||
        bytes>this.policy.ownerMinuteBytes-own)return 'DENIED_RATE';
      this.db.prepare(
        'INSERT INTO budget_artifact_chunks'+
        '(request_id,owner_id,device_id,project_id,session_id,'+
        'offset_bytes,byte_count,chunk_sha256,accepted_at_ms,state)'+
        ' VALUES(?,?,?,?,?,?,?,?,?,?)'
      ).run(x.requestId,x.ownerId,x.deviceId,x.projectId,x.sessionId,
        offset,bytes,x.chunkSha256,t,'PENDING');
      return 'CHUNK_PENDING';
    });
  }
  commitChunk(x:TrustedDurableChunkReceipt):BudgetDecision {
    id(x.ownerId,'OWNER');id(x.deviceId,'DEVICE');id(x.projectId,'PROJECT');
    id(x.sessionId,'SESSION');id(x.requestId,'REQUEST');
    sha(x.storedSha256);count(x.offsetBytes,'OFFSET');count(x.byteCount,'BYTES');
    if(x.durableStorageVerified!==true)throw Error('DURABLE_RECEIPT_REQUIRED');
    return this.transaction(()=>{
      const chunk=this.chunk(x.requestId);
      if(!chunk||!subjectMatch(chunk,x)||chunk.session_id!==x.sessionId)
        return 'DENIED_OWNER';
      if(chunk.offset_bytes!==x.offsetBytes||
         chunk.byte_count!==x.byteCount||
         chunk.chunk_sha256!==x.storedSha256)return 'DENIED_REPLAY';
      if(chunk.state==='COMMITTED')return 'CHUNK_ALREADY_COMMITTED';
      const s=this.session(x.sessionId);
      if(!s||!subjectMatch(s,x)||s.state!=='OPEN')return 'DENIED_STATE';
      if(s.offset_bytes!==x.offsetBytes)return 'DENIED_OFFSET';
      this.db.prepare(
        'UPDATE budget_artifact_chunks SET state=? WHERE request_id=?'
      ).run('COMMITTED',x.requestId);
      this.db.prepare(
        'UPDATE budget_artifact_sessions SET offset_bytes=? WHERE session_id=?'
      ).run(x.offsetBytes+x.byteCount,x.sessionId);
      return 'CHUNK_COMMITTED';
    });
  }
  finalize(x:TrustedDurableFinalReceipt):BudgetDecision {
    id(x.ownerId,'OWNER');id(x.deviceId,'DEVICE');id(x.projectId,'PROJECT');
    id(x.sessionId,'SESSION');sha(x.storedSha256);count(x.storedSizeBytes,'SIZE');
    if(x.durableStorageVerified!==true)throw Error('DURABLE_RECEIPT_REQUIRED');
    return this.transaction(()=>{
      const s=this.session(x.sessionId);
      if(!s||!subjectMatch(s,x))return 'DENIED_OWNER';
      if(s.size_bytes!==x.storedSizeBytes||s.source_sha256!==x.storedSha256)
        return 'DENIED_REPLAY';
      if(s.state==='COMPLETE')return 'ALREADY_COMPLETE';
      if(s.state!=='OPEN'||s.offset_bytes!==s.size_bytes)return 'DENIED_STATE';
      const pending=this.sum(
        'SELECT COUNT(*) AS n FROM budget_artifact_chunks WHERE session_id=? AND state=?',
        [x.sessionId,'PENDING']);
      if(pending)return 'DENIED_PENDING';
      this.db.prepare('UPDATE budget_artifact_sessions SET state=? WHERE session_id=?')
        .run('COMPLETE',x.sessionId);
      // Retain storage charge after COMPLETE: the file still occupies disk.
      return 'COMPLETE';
    });
  }
  /**
   * Durable cancellation tombstone. Stop new chunks/commit and retain the
   * full storage reservation until all in-flight writers are fenced and
   * an independent durable deletion receipt has been verified by #08.
   * NO 60-second byte-budget credit is refunded after cancellation.
   */
  requestCancel(x:TrustedArtifactCancel):BudgetDecision {
    id(x.ownerId,'OWNER');id(x.deviceId,'DEVICE');id(x.projectId,'PROJECT');
    id(x.sessionId,'SESSION');count(x.expectedOffsetBytes,'OFFSET');
    return this.transaction(()=>{
      const s=this.session(x.sessionId);
      if(!s||!subjectMatch(s,x))return 'DENIED_OWNER';
      if(s.state==='CANCEL_PENDING')return s.offset_bytes===x.expectedOffsetBytes
        ?'ALREADY_CANCEL_PENDING':'DENIED_OFFSET';
      if(s.state!=='OPEN')return 'DENIED_STATE';
      if(s.offset_bytes!==x.expectedOffsetBytes)return 'DENIED_OFFSET';
      this.db.prepare(
        'UPDATE budget_artifact_sessions SET state=? WHERE session_id=?'
      ).run('CANCEL_PENDING',x.sessionId);
      return 'CANCEL_PENDING';
    });
  }
  acknowledgeDeletion(x:TrustedRemovedReceipt):BudgetDecision {
    id(x.ownerId,'OWNER');id(x.deviceId,'DEVICE');id(x.projectId,'PROJECT');
    id(x.sessionId,'SESSION');
    if(x.durableDeletionVerified!==true)throw Error('DELETION_RECEIPT_REQUIRED');
    return this.transaction(()=>{
      const s=this.session(x.sessionId);
      if(!s||!subjectMatch(s,x))return 'DENIED_OWNER';
      if(s.state==='RELEASED')return 'RELEASED';
      if(s.state!=='COMPLETE'&&s.state!=='CANCEL_PENDING')return 'DENIED_STATE';
      // Cancelled writes may have an unknown in-flight write/ACK.
      if(s.state==='CANCEL_PENDING'&&x.writersStoppedVerified!==true)
        throw Error('WRITER_FENCE_REQUIRED');
      this.db.prepare('UPDATE budget_artifact_sessions SET state=? WHERE session_id=?')
        .run('RELEASED',x.sessionId);
      return 'RELEASED';
    });
  }
}
