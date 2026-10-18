import {DatabaseSync} from 'node:sqlite';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

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
  constructor(private readonly file:string, options:{
    maxRecords?:number;now?:()=>Date
  }={}){
    if(!path.isAbsolute(file))throw new Error('Agent journal path must be absolute');
    if(options.maxRecords!==undefined && (!Number.isSafeInteger(options.maxRecords) ||
      options.maxRecords<1||options.maxRecords>10_000_000)){
      throw new Error('Agent journal capacity invalid');
    }
    this.maxRecords=options.maxRecords;
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
    });
  }
  private read(db:DatabaseSync,id:string):AgentOperationRecord|undefined{
    const row=db.prepare(
      'SELECT request_id,fingerprint,capability,status,created_at,updated_at,'+
      'process_exit_code,task_success,timed_out,has_execution '+
      'FROM agent_operation_journal WHERE request_id=?',
    ).get(id) as DbRow|undefined;
    return row?this.map(row):undefined;
  }
  async initialize():Promise<void>{
    if(this.loaded)return;
    if(this.loading)return this.loading;
    this.loading=(async()=>{
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
      const db=new DatabaseSync(this.file);
      try{
        db.exec('PRAGMA busy_timeout=5000');
        db.exec('PRAGMA journal_mode=WAL');
        db.exec('PRAGMA synchronous=FULL');
        db.exec("CREATE TABLE IF NOT EXISTS agent_operation_journal ("+
          "request_id TEXT PRIMARY KEY NOT NULL,"+
          "fingerprint TEXT NOT NULL,"+
          "capability TEXT NOT NULL,"+
          "status TEXT NOT NULL CHECK(status IN "+
          "('in_progress','succeeded','failed','unknown')),"+
          "created_at TEXT NOT NULL, updated_at TEXT NOT NULL,"+
          "process_exit_code INTEGER, task_success INTEGER, timed_out INTEGER,"+
          "has_execution INTEGER NOT NULL DEFAULT 0 CHECK(has_execution IN (0,1)))");
        // SQLite transaction is atomic; a previous agent crash makes a
        // reserved unfinished mutation ambiguous, never unseen.
        this.transaction(db,()=>{
          db.prepare(
            "UPDATE agent_operation_journal SET status='unknown',updated_at=? "+
            "WHERE status='in_progress'",
          ).run(this.time());
        });
        this.db=db;
        this.loaded=true;
      }catch(e){
        db.close();throw e;
      }
    })();
    try{await this.loading}finally{this.loading=undefined}
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
    return this.transaction(db,()=>{
      const old=this.read(db,requestId);
      if(old){
        if(old.fingerprint!==fingerprint||old.capability!==capability){
          throw new AgentOperationJournalError(
            'AGENT_JOURNAL_REQUEST_MISMATCH',
            'Agent request ID reused with different mutation fingerprint.',
            {requestId},
          );
        }
        return {created:false,record:old};
      }
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
      return {created:true,record:this.read(db,requestId)!};
    });
  }
  async complete(
    requestId:string,
    status:'succeeded'|'failed'|'unknown',
    execution?:{processExitCode:number|null;taskSuccess:boolean;timedOut:boolean},
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
    const db=this.sql();
    return this.transaction(db,()=>{
      const previous=this.read(db,requestId);
      if(!previous||previous.status!=='in_progress'){
        throw new AgentOperationJournalError(
          'AGENT_JOURNAL_TRANSITION_DENIED',
          'Cannot transition absent or finalized Agent operation.',
          {requestId},
        );
      }
      db.prepare(
        'UPDATE agent_operation_journal SET status=?,updated_at=?,'+
        'process_exit_code=?,task_success=?,timed_out=?,has_execution=? '+
        "WHERE request_id=? AND status='in_progress'",
      ).run(status,this.time(),execution?.processExitCode??null,
        execution?Number(execution.taskSuccess):null,
        execution?Number(execution.timedOut):null,Number(Boolean(execution)),
        requestId);
      return this.read(db,requestId)!;
    });
  }
  close():void{
    this.db?.close();
    this.db=undefined;
    this.loaded=false;
  }
}
