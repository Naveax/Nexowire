import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import {verifyAgentJournalWal} from './operation-journal-wal.js';
import {readJournalOwnerProcess} from './journal-owner-process.js';
import {JournalAuthority,JournalAuthorityError,type AuthorityConfig} from './operation-journal-authority.js';

const Fingerprint=z.string().regex(/^[a-f0-9]{64}$/);
const Rec=z.object({
  requestId:z.string().uuid(),
  fingerprint:Fingerprint,
  capability:z.string().min(1).max(128),
  status:z.enum(['in_progress','succeeded','failed','unknown']),
  createdAt:z.string().datetime(),
  updatedAt:z.string().datetime(),
  processExitCode:z.number().int().nullable().optional(),
  taskSuccess:z.boolean().optional(),
  timedOut:z.boolean().optional(),
  dispatchedAt:z.string().datetime().optional(),
  evidenceKind:z.enum(['shell_exit','file_write_ack','service_readback']).optional(),
  evidenceVerified:z.boolean().optional(),
  archived:z.boolean().optional(),
}).strict();
export type AgentOperationRecord=z.infer<typeof Rec>;
export class AgentOperationJournalError extends Error{
  constructor(public readonly code:string,message:string,
    public readonly details?:Record<string,unknown>){
    super(message);this.name='AgentOperationJournalError';
  }
}
type DbRow={
  request_id:string;
  fingerprint:string;
  capability:string;
  status:'in_progress'|'succeeded'|'failed'|'unknown';
  created_at:string;
  updated_at:string;
  process_exit_code:number|null;
  task_success:number|null;
  timed_out:number|null;
  has_execution:number;
  dispatched_at:string|null;
  evidence_kind:string|null;
  evidence_verified:number|null;
};

/**
 * Agent-owned, durable, metadata-only mutation journal (SQLite WAL/FULL).
 * Never stores command, input, credentials, stdout/stderr or result content.
 * A successful Agent response does NOT guarantee a successful shell exit;
 * processExitCode/taskSuccess/timedOut capture this distinction when known.
 *
 * The native-agent process MUST hold its singleton lock. A STARTED mutation
 * cannot be rolled back by this journal and is never retried automatically.
 */
export class AgentOperationJournal{
  private db?:DatabaseSync;
  private loading?:Promise<void>;
  private loaded=false;
  private readonly maxRecords:number|undefined;
  private readonly now:()=>Date;
  private readonly leaseId=randomUUID();
  private readonly authority?:JournalAuthority;
  private readonly maxPageGrowth:number|undefined;
  constructor(private readonly file:string, options:{
    maxRecords?:number;now?:()=>Date;maxPageGrowth?:number;
    authority?:AuthorityConfig
  }={}){
    if(!path.isAbsolute(file))throw new Error('Agent journal path must be absolute');
    if(options.maxRecords!==undefined && (!Number.isSafeInteger(options.maxRecords) ||
      options.maxRecords<1||options.maxRecords>10_000_000)){
      throw new Error('Agent journal capacity invalid');
    }
    if(options.maxPageGrowth!==undefined &&
      (!Number.isSafeInteger(options.maxPageGrowth)||
        options.maxPageGrowth<0||options.maxPageGrowth>1000)){
      throw new Error('Journal test page-growth limit invalid');
    }
    this.maxRecords=options.maxRecords;
    if(options.authority&&path.resolve(path.dirname(options.authority.file)).toLowerCase()===
       path.resolve(path.dirname(file)).toLowerCase()){
      throw new JournalAuthorityError('AGENT_AUTHORITY_COLOCATED',
        'Anti-replay authority may not share the journal backup directory.');
    }
    this.authority=options.authority?new JournalAuthority(options.authority):undefined;
    this.maxPageGrowth=options.maxPageGrowth;
    this.now=options.now??(()=>new Date());
  }
  private time():string{
    const d=this.now();
    if(!(d instanceof Date)||!Number.isFinite(d.getTime())){
      throw new AgentOperationJournalError('AGENT_JOURNAL_CLOCK_INVALID',
        'Trusted agent journal clock is invalid.');
    }
    return d.toISOString();
  }
  private sql():DatabaseSync{
    if(!this.db)throw new AgentOperationJournalError(
      'AGENT_JOURNAL_UNAVAILABLE','Agent journal database unavailable.');
    return this.db;
  }
  private map(row:DbRow):AgentOperationRecord{
    return Rec.parse({
      requestId:row.request_id,fingerprint:row.fingerprint,
      capability:row.capability,status:row.status,
      createdAt:row.created_at,updatedAt:row.updated_at,
      ...(row.has_execution===1?{
        processExitCode:row.process_exit_code,
        taskSuccess:row.task_success===1,
        timedOut:row.timed_out===1,
      }:{}),
      ...(row.dispatched_at?{dispatchedAt:row.dispatched_at}:{}),
      ...(row.evidence_kind?{
        evidenceKind:row.evidence_kind,
        evidenceVerified:row.evidence_verified===1,
      }:{}),
    });
  }
  private read(db:DatabaseSync,id:string):AgentOperationRecord|undefined{
    const fields='request_id,fingerprint,capability,status,created_at,updated_at,'+
      'process_exit_code,task_success,timed_out,has_execution,'+
      'dispatched_at,evidence_kind,evidence_verified';
    const row=db.prepare('SELECT '+fields+
      ' FROM agent_operation_journal WHERE request_id=?').get(id) as DbRow|undefined;
    if(row)return this.map(row);
    const archived=db.prepare('SELECT '+fields+
      ' FROM agent_operation_archive WHERE request_id=?').get(id) as DbRow|undefined;
    return archived?{...this.map(archived),archived:true}:undefined;
  }
  async initialize():Promise<void>{
    if(this.loaded)return;
    if(this.loading)return this.loading;
    this.loading=(async()=>{
      // An authority is never auto-provisioned from a journal snapshot.
      await this.authority?.initialize();
      await fs.mkdir(path.dirname(this.file),{recursive:true});
      try{
        const current=await fs.lstat(this.file);
        if(!current.isFile()||current.isSymbolicLink()){
          throw new AgentOperationJournalError(
            'AGENT_JOURNAL_FILE_INVALID','Agent journal path is not a regular file.');
        }
      }catch(e){
        if((e as NodeJS.ErrnoException)?.code!=='ENOENT')throw e;
      }
      // SQLite recovery may silently truncate invalid frames and discard a
      // committed anti-replay tombstone. Validate the full WAL before opening.
      await verifyAgentJournalWal(this.file);
      const shm=this.file+'-shm';
      try{
        const stat=await fs.lstat(shm);
        if(!stat.isFile()||stat.isSymbolicLink()){
          throw new AgentOperationJournalError('AGENT_JOURNAL_SIDECAR_INVALID',
            'SQLite shared-memory sidecar is not a regular file.');
        }
      }catch(e){
        if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
      }
      const db=new DatabaseSync(this.file);
      try{
        db.exec('PRAGMA busy_timeout=5000');
        db.exec('PRAGMA journal_mode=WAL');
        db.exec('PRAGMA synchronous=FULL');
        db.exec('PRAGMA foreign_keys=ON');
        db.exec("CREATE TABLE IF NOT EXISTS agent_operation_journal ("+
          "request_id TEXT PRIMARY KEY NOT NULL,"+
          "fingerprint TEXT NOT NULL,"+
          "capability TEXT NOT NULL,"+
          "status TEXT NOT NULL CHECK(status IN "+
          "('in_progress','succeeded','failed','unknown')),"+
          "created_at TEXT NOT NULL, updated_at TEXT NOT NULL,"+
          "process_exit_code INTEGER, task_success INTEGER, timed_out INTEGER,"+
          "has_execution INTEGER NOT NULL DEFAULT 0 CHECK(has_execution IN (0,1)))");
        // Retain v1 entries; migration adds only payload-free evidence columns.
        const existing=db.prepare('PRAGMA table_info(agent_operation_journal)')
          .all() as Array<{name:string}>;
        for(const [name,sqlType] of [
          ['dispatched_at','TEXT'],
          ['evidence_kind','TEXT'],
          ['evidence_verified','INTEGER'],
        ] as const){
          if(!existing.some(column=>column.name===name)){
            db.exec('ALTER TABLE agent_operation_journal ADD COLUMN '+name+' '+sqlType);
          }
        }
        db.exec('CREATE TABLE IF NOT EXISTS agent_operation_archive AS '+
          'SELECT * FROM agent_operation_journal WHERE 0');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS agent_operation_archive_id '+
          'ON agent_operation_archive(request_id)');
        db.exec('CREATE TABLE IF NOT EXISTS agent_operation_owner ('+
          'id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,'+
          'nonce TEXT NOT NULL)');
        if(this.authority){
          db.exec('CREATE TABLE IF NOT EXISTS agent_operation_authority_binding ('+
            'id INTEGER PRIMARY KEY CHECK(id=1),authority_id TEXT NOT NULL,'+
            'generation TEXT NOT NULL,last_sequence INTEGER NOT NULL)');
        }
        const integrity=db.prepare('PRAGMA quick_check').get() as
          {quick_check:string}|undefined;
        if(integrity?.quick_check!=='ok'){
          throw new AgentOperationJournalError('AGENT_JOURNAL_CORRUPT',
            'SQLite integrity check failed. Refusing mutations.');
        }
        this.transaction(db,()=>{
          const ownerColumns=db.prepare('PRAGMA table_info(agent_operation_owner)').all() as {name:string}[];
          if(!ownerColumns.some(c=>c.name==='process_identity'))
            db.exec('ALTER TABLE agent_operation_owner ADD COLUMN process_identity TEXT');
        });
        type Owner={pid:number;nonce:string;process_identity:string|null};
        const before=db.prepare('SELECT pid,nonce,process_identity FROM agent_operation_owner WHERE id=1').get() as Owner|undefined;
        const self=await readJournalOwnerProcess(process.pid);
        if(process.platform==='win32'&&self.state!=='alive')throw new AgentOperationJournalError(
          'AGENT_JOURNAL_OWNER_UNVERIFIED','Current Windows process incarnation unavailable; mutation ownership denied.');
        const observed=before?await readJournalOwnerProcess(before.pid):undefined;
        // BEGIN IMMEDIATE serializes independent connections/processes.
        // Never misclassify another live process's in-flight request.
        this.transaction(db,()=>{
          if(this.authority){
            const binding=this.binding(db);
            const latest=this.authority.head();
            if(!binding){
              const rows=db.prepare('SELECT ('+
                '(SELECT COUNT(*) FROM agent_operation_journal)+'+
                '(SELECT COUNT(*) FROM agent_operation_archive)) AS count')
                .get() as {count:number};
              if(rows.count!==0||latest!==0)throw new JournalAuthorityError(
                'AGENT_AUTHORITY_MIGRATION_REQUIRED',
                'Non-empty journal or authority needs independently verified migration.');
              const {authorityId,generation}=this.authority.config;
              db.prepare('INSERT INTO agent_operation_authority_binding VALUES(1,?,?,0)')
                .run(authorityId,generation);
            }else{
              this.guardAuthority(db);
            }
          }
          const previous=db.prepare('SELECT pid,nonce,process_identity FROM agent_operation_owner WHERE id=1')
            .get() as Owner|undefined;
          if(JSON.stringify(previous)!==JSON.stringify(before))throw new AgentOperationJournalError(
            'AGENT_JOURNAL_IN_USE','Journal owner changed during process identity readback.');
          if(previous){
            if(!Number.isSafeInteger(previous.pid)||previous.pid<=0||previous.pid>0x7fffffff||
                !z.string().uuid().safeParse(previous.nonce).success)
              throw new AgentOperationJournalError('AGENT_JOURNAL_IN_USE','Stored journal owner identity is invalid; takeover denied.');
            let stillAlive=observed?.state!=='dead';
            const knownIdentity=typeof previous.process_identity==='string'&&
              /^(?:win32:[a-f0-9]{16}|linux:[a-f0-9-]{36}:\d+)$/.test(previous.process_identity);
            if(observed?.state==='alive'&&knownIdentity&&
                previous.process_identity!.split(':')[0]===observed.identity.split(':')[0]&&
                observed.identity!==previous.process_identity)stillAlive=false;
            if(observed?.state==='unknown'){
              try{process.kill(previous.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')stillAlive=false;}
            }
            if(stillAlive){
              throw new AgentOperationJournalError('AGENT_JOURNAL_IN_USE',
                'Another journal owner may be executing mutations.');
            }
          }
          db.prepare('INSERT OR REPLACE INTO agent_operation_owner(id,pid,nonce,process_identity) '+
            'VALUES(1,?,?,?)').run(process.pid,this.leaseId,self.state==='alive'?self.identity:null);
          // Only a new exclusive owner may recover incomplete reservations.
          db.prepare(
            "UPDATE agent_operation_journal SET status='unknown',updated_at=? "+
            "WHERE status='in_progress'",
          ).run(this.time());
        });
        if(this.maxPageGrowth!==undefined){
          // Test-only deterministic SQLITE_FULL injection in an isolated DB.
          // No real disk or live Agent is filled.
          const pages=db.prepare('PRAGMA page_count').get() as
            {page_count:number};
          db.exec('PRAGMA max_page_count='+
            (pages.page_count+this.maxPageGrowth));
        }
        this.db=db;
        this.loaded=true;
      }catch(e){
        db.close();this.authority?.close();throw e;
      }
    })();
    try{await this.loading}
    catch(e){this.authority?.close();throw e}
    finally{this.loading=undefined}
  }
  private binding(db:DatabaseSync):{authority_id:string;generation:string;last_sequence:number}|undefined{
    return db.prepare('SELECT authority_id,generation,last_sequence '+
      'FROM agent_operation_authority_binding WHERE id=1').get() as
      {authority_id:string;generation:string;last_sequence:number}|undefined;
  }
  private guardAuthority(db:DatabaseSync):number{
    if(!this.authority)return 0;
    const b=this.binding(db);
    const c=this.authority.config;
    if(!b||b.authority_id!==c.authorityId||b.generation!==c.generation ||
       b.last_sequence!==this.authority.head()){
      throw new JournalAuthorityError('AGENT_AUTHORITY_ROLLBACK_DETECTED',
        'Journal and independently maintained monotonic reservation epoch differ.');
    }
    return b.last_sequence;
  }
  private transaction<T>(db:DatabaseSync,fn:()=>T):T{
    db.exec('BEGIN IMMEDIATE');
    try{
      const result=fn();
      db.exec('COMMIT');
      return result;
    }catch(e){
      try{db.exec('ROLLBACK')}catch{}
      throw e;
    }
  }
  async inspect(requestId:string):Promise<AgentOperationRecord|undefined>{
    await this.initialize();
    z.string().uuid().parse(requestId);
    const row=this.read(this.sql(),requestId);
    return row?{...row}:undefined;
  }
  async begin(requestId:string,fingerprint:string,capability:string):
    Promise<{created:boolean;record:AgentOperationRecord}>{
    await this.initialize();
    z.string().uuid().parse(requestId);
    Fingerprint.parse(fingerprint);
    z.string().min(1).max(128).parse(capability);
    const db=this.sql();
    // Reserve at the independent authority FIRST. If Agent crashes between
    // commits, the orphaned ID is unavailable and journal epoch fails closed.
    const before=this.guardAuthority(db);
    const authorityReservation=this.authority?.reserve(requestId,fingerprint,capability);
    return this.transaction(db,()=>{
      if(this.authority){
        const b=this.binding(db);
        if(!b||b.last_sequence!==before||
           this.authority.head()!==(authorityReservation!.created?
             authorityReservation!.sequence:before)){
          throw new JournalAuthorityError('AGENT_AUTHORITY_ROLLBACK_DETECTED',
            'Authority epoch changed during reservation.');
        }
      }
      const old=this.read(db,requestId);
      if(old){
        if(this.authority&&authorityReservation?.created)throw new JournalAuthorityError(
          'AGENT_AUTHORITY_ROLLBACK_DETECTED','Journal references missing authority reservation.');
        if(old.fingerprint!==fingerprint||old.capability!==capability){
          throw new AgentOperationJournalError(
            'AGENT_JOURNAL_REQUEST_MISMATCH',
            'Agent request ID reused with different mutation fingerprint.',
            {requestId},
          );
        }
        return {created:false,record:old};
      }
      if(this.authority&&!authorityReservation?.created)throw new JournalAuthorityError(
        'AGENT_AUTHORITY_ROLLBACK_DETECTED',
        'Historical authority reservation missing from journal; replay denied.');
      if(this.maxRecords!==undefined){
        const row=db.prepare('SELECT COUNT(*) AS count FROM agent_operation_journal')
          .get() as {count:number};
        if(row.count>=this.maxRecords){
          throw new AgentOperationJournalError('AGENT_JOURNAL_FULL',
            'Agent journal full. Refusing mutation until retention review.');
        }
      }
      const stamp=this.time();
      db.prepare(
        'INSERT INTO agent_operation_journal '+
        '(request_id,fingerprint,capability,status,created_at,updated_at) '+
        "VALUES(?,?,?,'in_progress',?,?)",
      ).run(requestId,fingerprint,capability,stamp,stamp);
      if(this.authority){
        db.prepare('UPDATE agent_operation_authority_binding SET last_sequence=? WHERE id=1')
          .run(authorityReservation!.sequence);
      }
      return {created:true,record:this.read(db,requestId)!};
    });
  }
  async markDispatched(requestId:string,fingerprint:string):Promise<AgentOperationRecord>{
    await this.initialize();
    z.string().uuid().parse(requestId);
    Fingerprint.parse(fingerprint);
    const db=this.sql();
    return this.transaction(db,()=>{
      this.guardAuthority(db);
      const updated=db.prepare(
        'UPDATE agent_operation_journal SET dispatched_at=? '+
        "WHERE request_id=? AND fingerprint=? AND status='in_progress' "+
        'AND dispatched_at IS NULL',
      ).run(this.time(),requestId,fingerprint);
      if(updated.changes!==1){
        throw new AgentOperationJournalError('AGENT_JOURNAL_DISPATCH_DENIED',
          'Dispatch marker CAS not confirmed; executor must not run.',{requestId});
      }
      return this.read(db,requestId)!;
    });
  }
  async complete(
    requestId:string,
    status:'succeeded'|'failed'|'unknown',
    execution?:{processExitCode:number|null;taskSuccess:boolean;timedOut:boolean},
    evidence?:{kind:'shell_exit'|'file_write_ack'|'service_readback';verified:boolean},
    expectedFingerprint?:string,
  ):Promise<AgentOperationRecord>{
    await this.initialize();
    z.string().uuid().parse(requestId);
    if(execution){
      if(execution.processExitCode!==null &&
         (!Number.isSafeInteger(execution.processExitCode)||
          Math.abs(execution.processExitCode)>2147483647)||
         typeof execution.taskSuccess!=='boolean'||
         typeof execution.timedOut!=='boolean'){
        throw new AgentOperationJournalError(
          'AGENT_JOURNAL_OUTCOME_INVALID','Invalid process outcome metadata.');
      }
    }
    if(evidence){
      z.object({
        kind:z.enum(['shell_exit','file_write_ack','service_readback']),
        verified:z.boolean(),
      }).strict().parse(evidence);
    }
    if(expectedFingerprint!==undefined)Fingerprint.parse(expectedFingerprint);
    const db=this.sql();
    return this.transaction(db,()=>{
      this.guardAuthority(db);
      const previous=this.read(db,requestId);
      if(!previous||previous.status!=='in_progress'||
         (expectedFingerprint!==undefined &&
          previous.fingerprint!==expectedFingerprint)){
        throw new AgentOperationJournalError(
          'AGENT_JOURNAL_TRANSITION_DENIED',
          'Cannot transition absent or finalized Agent operation.',
          {requestId},
        );
      }
      db.prepare(
        'UPDATE agent_operation_journal SET status=?,updated_at=?,'+
        'process_exit_code=?,task_success=?,timed_out=?,has_execution=?,'+
        'evidence_kind=?,evidence_verified=? '+
        "WHERE request_id=? AND status='in_progress' AND fingerprint=?",
      ).run(status,this.time(),execution?.processExitCode??null,
        execution?Number(execution.taskSuccess):null,
        execution?Number(execution.timedOut):null,Number(Boolean(execution)),
        evidence?.kind??null,evidence?Number(evidence.verified):null,
        requestId,previous.fingerprint);
      return this.read(db,requestId)!;
    });
  }
  /**
   * Metadata-only archival. Never purge request IDs or UNKNOWN states:
   * removing a tombstone would permit a replay after restart.
   */
  async archiveCompleted(before:string,limit=500):Promise<number>{
    await this.initialize();
    z.string().datetime().parse(before);
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000){
      throw new AgentOperationJournalError('AGENT_JOURNAL_ARCHIVE_LIMIT',
        'Archive batch must contain 1..1000 records.');
    }
    const db=this.sql();
    return this.transaction(db,()=>{
      const rows=db.prepare(
        "SELECT request_id FROM agent_operation_journal "+
        "WHERE status IN ('succeeded','failed') AND updated_at<? "+
        'ORDER BY updated_at,request_id LIMIT ?',
      ).all(before,limit) as Array<{request_id:string}>;
      for(const {request_id:id} of rows){
        db.prepare('INSERT INTO agent_operation_archive '+
          'SELECT * FROM agent_operation_journal WHERE request_id=?').run(id);
        db.prepare('DELETE FROM agent_operation_journal WHERE request_id=?').run(id);
      }
      return rows.length;
    });
  }
  async checkpoint():Promise<void>{
    await this.initialize();
    const row=this.sql().prepare('PRAGMA wal_checkpoint(TRUNCATE)')
      .get() as {busy:number}|undefined;
    if(row?.busy!==0)throw new AgentOperationJournalError(
      'AGENT_JOURNAL_CHECKPOINT_BUSY','WAL checkpoint did not complete.');
  }
  close():void{
    if(!this.db)return;
    try{
      this.transaction(this.db,()=>{
        this.db!.prepare('DELETE FROM agent_operation_owner '+
          'WHERE id=1 AND pid=? AND nonce=?').run(process.pid,this.leaseId);
      });
    }finally{
      this.db.close();
      this.authority?.close();
      this.db=undefined;
      this.loaded=false;
    }
  }
}
