import {DatabaseSync} from 'node:sqlite';
import {promises as fs,lstatSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {verifyAgentJournalWal} from './operation-journal-wal.js';

/**
 * Separate durable anti-replay authority. Its storage MUST be provisioned
 * independently of the journal, on a rollback-independent trust boundary.
 * A second DB copied/restored alongside the journal is NOT sufficient.
 * Only opaque request IDs, hashes and capability names are stored.
 */
export class JournalAuthorityError extends Error {
  constructor(public readonly code:string,message:string){
    super(message);this.name='JournalAuthorityError';
  }
}
export interface AuthorityConfig {file:string;authorityId:string;generation:string}
export interface AuthorityReservation {sequence:number;created:boolean}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fingerprint=/^[a-f0-9]{64}$/;
function denied(code:string,message:string):never{
  throw new JournalAuthorityError(code,message);
}
function configValid(config:AuthorityConfig):void{
  if(!path.isAbsolute(config.file)||!uuid.test(config.authorityId)||
     !uuid.test(config.generation))denied('AGENT_AUTHORITY_INVALID','Authority identity/path invalid.');
}
function openDb(file:string):DatabaseSync{
  const db=new DatabaseSync(file);
  try{
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=FULL');
    return db;
  }catch(e){db.close();throw e}
}
/** Explicit operator/test-only provisioning; NEVER performed by Agent startup. */
export async function provisionJournalAuthority(config:AuthorityConfig):Promise<void>{
  configValid(config);
  await fs.mkdir(path.dirname(config.file),{recursive:true});
  const handle=await fs.open(config.file,'wx',0o600);
  await handle.close();
  const db=openDb(config.file);
  try{
    db.exec('CREATE TABLE authority_meta(id INTEGER PRIMARY KEY CHECK(id=1),'+
      'authority_id TEXT NOT NULL,generation TEXT NOT NULL)');
    db.exec('CREATE TABLE reservations('+
      'sequence INTEGER PRIMARY KEY AUTOINCREMENT,'+
      'request_id TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,'+
      'capability TEXT NOT NULL)');
    db.prepare('INSERT INTO authority_meta VALUES(1,?,?)').run(
      config.authorityId,config.generation);
  }finally{db.close()}
}
export class JournalAuthority {
  private db?:DatabaseSync;
  private identity?:{dev:number;ino:number};
  constructor(readonly config:AuthorityConfig){configValid(config)}
  async initialize():Promise<void>{
    if(this.db)return;
    // Refuse silent bootstrap, symlinks, missing storage, or mismatched epoch.
    let info;
    try{info=await fs.lstat(this.config.file)}catch{
      denied('AGENT_AUTHORITY_UNAVAILABLE','Independent anti-replay authority missing.');
    }
    if(!info.isFile()||info.isSymbolicLink()){
      denied('AGENT_AUTHORITY_UNAVAILABLE','Authority path is not a regular file.');
    }
    await verifyAgentJournalWal(this.config.file);
    for(const suffix of ['-shm']){
      try{
        const st=await fs.lstat(this.config.file+suffix);
        if(!st.isFile()||st.isSymbolicLink())denied(
          'AGENT_AUTHORITY_UNAVAILABLE','Authority sidecar invalid.');
      }catch(e){
        if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
      }
    }
    const db=openDb(this.config.file);
    try{
      const check=db.prepare('PRAGMA quick_check').get() as
        {quick_check:string}|undefined;
      if(check?.quick_check!=='ok')denied(
        'AGENT_AUTHORITY_CORRUPT','Authority SQLite integrity failed.');
      const meta=db.prepare('SELECT authority_id,generation FROM authority_meta WHERE id=1')
        .get() as {authority_id:string;generation:string}|undefined;
      if(!meta||meta.authority_id!==this.config.authorityId||
         meta.generation!==this.config.generation)denied(
        'AGENT_AUTHORITY_EPOCH_MISMATCH','Trusted authority epoch differs.');
      this.identity={dev:info.dev,ino:info.ino};
      this.db=db;
    }catch(e){db.close();throw e}
  }
  private sql():DatabaseSync{
    if(!this.db||!this.identity)denied(
      'AGENT_AUTHORITY_UNAVAILABLE','Authority connection unavailable.');
    // Fail closed if a path is renamed, replaced, or detached after opening.
    // Physical ACL protection and an independent rollback boundary remain
    // mandatory; this path check is not a trusted remote attestation.
    let info;
    try{info=lstatSync(this.config.file)}catch{
      denied('AGENT_AUTHORITY_UNAVAILABLE','Authority path disappeared.');
    }
    if(!info.isFile()||info.isSymbolicLink()||
       info.dev!==this.identity!.dev||info.ino!==this.identity!.ino){
      denied('AGENT_AUTHORITY_UNAVAILABLE','Authority file identity changed.');
    }
    return this.db!;
  }
  head():number{
    const record=this.sql().prepare(
      'SELECT COALESCE(MAX(sequence),0) AS seq FROM reservations').get() as {seq:number};
    return record.seq;
  }
  reserve(requestId:string,hash:string,capability:string):AuthorityReservation{
    if(!uuid.test(requestId)||!fingerprint.test(hash)||!capability||
       capability.length>128)denied('AGENT_AUTHORITY_INVALID','Invalid reservation metadata.');
    const db=this.sql();
    db.exec('BEGIN IMMEDIATE');
    try{
      const old=db.prepare('SELECT sequence,fingerprint,capability FROM reservations '+
        'WHERE request_id=?').get(requestId) as
        {sequence:number;fingerprint:string;capability:string}|undefined;
      if(old){
        if(old.fingerprint!==hash||old.capability!==capability)denied(
          'AGENT_AUTHORITY_REQUEST_MISMATCH','Historical request ID content mismatch.');
        db.exec('COMMIT');
        return {sequence:old.sequence,created:false};
      }
      const result=db.prepare('INSERT INTO reservations(request_id,fingerprint,capability) '+
        'VALUES(?,?,?)').run(requestId,hash,capability);
      db.exec('COMMIT');
      return {sequence:Number(result.lastInsertRowid),created:true};
    }catch(e){try{db.exec('ROLLBACK')}catch{}throw e}
  }
  close():void{this.db?.close();this.db=undefined;this.identity=undefined}
}
