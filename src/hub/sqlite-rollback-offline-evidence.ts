/** Read-only offline fixture inspection; never a live writer-fence or release authority. */
import {DatabaseSync} from 'node:sqlite';
import {lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';

export interface OfflineSqliteStatusEvidence {
  readonly schemaVersion:1;
  readonly sqliteRecords:number;
  readonly succeeded:number;
  readonly failed:number;
  readonly unknown:number;
  readonly inProgress:number;
}
function fail(code:string):never{throw Error('AI02_OFFLINE_RECOVERY_'+code)}
const samePath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function ordinary(file:string,optional:boolean):void{
  let stat;
  try{stat=lstatSync(file)}catch(error){
    if(optional&&(error as NodeJS.ErrnoException).code==='ENOENT')return;
    throw error;
  }
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!samePath(realpathSync(file),file))
    fail('FILE_UNTRUSTED');
}
/** Caller must supply an offline disposable copy, not an installed ledger.
 * The read-only SQLite connection may refresh its copied SHM. No DDL/DML,
 * checkpoint, restore, writer claim or runtime execution is performed.
 */
export function inspectOfflineSqliteStatus(root:string):Readonly<OfflineSqliteStatusEvidence>{
  if(!path.isAbsolute(root)||!samePath(realpathSync(root),root))fail('ROOT_UNTRUSTED');
  const dir=lstatSync(root);
  if(!dir.isDirectory()||dir.isSymbolicLink())fail('ROOT_UNTRUSTED');
  const file=path.join(root,'idempotency-records.sqlite');
  ordinary(file,false);ordinary(file+'-wal',true);ordinary(file+'-shm',true);
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const checks=db.prepare('PRAGMA quick_check').all();
    if(checks.length!==1||checks[0]?.quick_check!=='ok')fail('QUICK_CHECK_FAILED');
    const schemas=db.prepare("SELECT value FROM idempotency_meta WHERE key='schema_version'").all();
    if(schemas.length!==1||schemas[0]?.value!=='1')fail('SCHEMA_UNREVIEWED');
    const counts={succeeded:0,failed:0,unknown:0,in_progress:0};
    for(const row of db.prepare('SELECT status, count(*) AS count FROM idempotency_records GROUP BY status').all()){
      const status=row.status,count=row.count;
      if(typeof status!=='string'||!Object.hasOwn(counts,status)||
         typeof count!=='number'||!Number.isSafeInteger(count)||count<1)
        fail('STATUS_UNREVIEWED');
      counts[status as keyof typeof counts]=count;
    }
    const total=Object.values(counts).reduce((sum,n)=>sum+n,0);
    if(!Number.isSafeInteger(total))fail('COUNT_UNREVIEWED');
    return Object.freeze({schemaVersion:1,sqliteRecords:total,succeeded:counts.succeeded,
      failed:counts.failed,unknown:counts.unknown,inProgress:counts.in_progress});
  }finally{db.close()}
}
/** Unknown and in-progress rows are independent disqualifiers; never delete or
 * rewrite them to make rollback admissible. Zero rows is not writer fencing.
 */
export function assertOfflineSqliteNoUnresolvedOperations(evidence:OfflineSqliteStatusEvidence):void{
  if(evidence.unknown!==0||evidence.inProgress!==0)fail('UNRESOLVED_OPERATIONS');
}
