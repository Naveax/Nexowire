/**
 * AI-04: read-only inventory for the legacy interactive Hub state before an
 * owner-authorized SYSTEM cutover. This does not migrate or attest a cutover.
 */
import {DatabaseSync} from 'node:sqlite';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';

export const SYSTEM_HUB_STATE_PATH='C:\\ProgramData\\Nexowire\\hub-state';

const REQUIRED=new Set(['audit.jsonl','credentials.json','devices.json',
  'idempotency-records.json','idempotency-records.sqlite']);
const SQLITE_COMPANIONS=new Set(['idempotency-records.sqlite-wal',
  'idempotency-records.sqlite-shm']);
const WORKSPACE=/^workspace-[0-9a-f]{64}\.json$/;
const LEGACY_BACKUP=/^idempotency-records\.json\.pre-sqlite-[0-9]+$/;

export interface LegacyHubStateInventory {
  mode:'READ_ONLY';
  sourceRoot:string;
  intendedSystemRoot:string;
  rootFileCount:number;
  workspaceFileCount:number;
  regularFileBytes:number;
  requiredFilesMissing:string[];
  unexpectedEntries:string[];
  rejectedLinkOrSpecialEntries:string[];
  nestedRecoveryBackupsPresent:boolean;
  sqliteRecords:number|null;
  sqliteQuickCheck:string|null;
  readyForSystemCutover:false;
  blockers:string[];
}

/** No target creation, no copy, no task changes, no secret plaintext reads. */
export async function scanLegacyHubStateReadOnly(
  sourceRoot:string,
):Promise<LegacyHubStateInventory>{
  if(typeof sourceRoot!=='string'||!path.win32.isAbsolute(sourceRoot)||
      sourceRoot.startsWith('\\\\')||sourceRoot.startsWith('\\\\?\\')||
      path.win32.normalize(sourceRoot).toLowerCase()!==sourceRoot.toLowerCase()){
    throw new Error('HUB_STATE_SOURCE_NONCANONICAL');
  }
  const source=await fs.lstat(sourceRoot);
  if(!source.isDirectory()||source.isSymbolicLink()){
    throw new Error('HUB_STATE_SOURCE_DIRECTORY_UNTRUSTED');
  }
  const names=await fs.readdir(sourceRoot,{withFileTypes:true});
  const required=new Set(REQUIRED);
  let workspaces=0,bytes=0,regular=0,backupDirectory=false;
  const unexpected:string[]=[],links:string[]=[];
  for(const entry of names){
    if(entry.name==='.'||entry.name==='..')throw new Error('HUB_STATE_ENTRY_NONCANONICAL');
    const file=path.join(sourceRoot,entry.name);
    const stat=await fs.lstat(file);
    if(stat.isSymbolicLink()||!stat.isFile()&&
        !(entry.name==='ai04-recovery-backups'&&stat.isDirectory())||
        stat.isFile()&&stat.nlink!==1){
      links.push(entry.name);continue;
    }
    if(entry.name==='ai04-recovery-backups'&&stat.isDirectory()){
      backupDirectory=true;continue;
    }
    regular++;
    bytes+=stat.size;
    if(required.has(entry.name)){required.delete(entry.name);continue;}
    if(WORKSPACE.test(entry.name)){workspaces++;continue;}
    if(SQLITE_COMPANIONS.has(entry.name)||LEGACY_BACKUP.test(entry.name))continue;
    unexpected.push(entry.name);
  }
  const dbName=path.join(sourceRoot,'idempotency-records.sqlite');
  let quick:string|null=null,records:number|null=null;
  if(!required.has('idempotency-records.sqlite')&&!links.includes('idempotency-records.sqlite')){
    const db=new DatabaseSync(dbName,{readOnly:true});
    try{
      quick=(db.prepare('PRAGMA quick_check').get() as {quick_check:string}).quick_check;
      records=(db.prepare('SELECT COUNT(*) AS n FROM idempotency_records').get() as {n:number}).n;
    }finally{db.close();}
  }
  const blockers=['OFFLINE_WRITER_QUIESCE_NOT_VERIFIED',
    'SYSTEM_PROGRAMDATA_ACL_NOT_VERIFIED',
    'FULL_STATE_AND_DPAPI_MIGRATION_NOT_PERFORMED',
    'REBOOT_AND_ROLLBACK_NOT_VERIFIED'];
  if(required.size>0)blockers.push('REQUIRED_STATE_FILE_MISSING');
  if(unexpected.length>0)blockers.push('UNRECOGNIZED_STATE_CONTENT');
  if(links.length>0)blockers.push('STATE_LINK_OR_HARDLINK_UNTRUSTED');
  if(quick!=='ok')blockers.push('SQLITE_QUICK_CHECK_NOT_OK');
  return {
    mode:'READ_ONLY',sourceRoot,
    intendedSystemRoot:SYSTEM_HUB_STATE_PATH,
    rootFileCount:regular,workspaceFileCount:workspaces,
    regularFileBytes:bytes,
    requiredFilesMissing:[...required].sort(),
    unexpectedEntries:unexpected.sort(),
    rejectedLinkOrSpecialEntries:links.sort(),
    nestedRecoveryBackupsPresent:backupDirectory,
    sqliteRecords:records,sqliteQuickCheck:quick,
    readyForSystemCutover:false,blockers,
  };
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  if(process.platform!=='win32')throw new Error('WINDOWS_STATE_INVENTORY_ONLY');
  if(process.argv.length!==3)throw new Error('Usage: node --import tsx scripts/ai04-system-state-inventory.ts C:\\Users\\Owner\\.nexowire\\hub');
  const result=await scanLegacyHubStateReadOnly(process.argv[2]!);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
